import path from "node:path"
import type { Shell } from "../host.js"

/**
 * Single-watcher lease: at most one watch-mode process per clone. The lease
 * is an atomically-created directory (`mkdir`, the same primitive the claim
 * markers trust) holding an `owner.json` with liveness timestamps. Liveness
 * is judged from the JSON's `heartbeatAt`, never fs mtime — DrvFS/WSL mtime
 * is unreliable. A dead watcher's lease is taken over once its heartbeat
 * ages past the stale threshold.
 *
 * This protects the cross-process races the claim markers cannot: git
 * `index.lock` contention, in-place appends, and branch switches from two
 * watchers sharing one clone (threat-model T3).
 */

export interface LeaseOwner {
  readonly pid: number
  readonly host: string
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly intervalMs: number
}

export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly owner: LeaseOwner | null }

export const leaseDir = (directory: string, tasksDir: string): string =>
  path.join(directory, tasksDir, "runs", ".watch-lease")

const ownerFile = (directory: string, tasksDir: string): string => path.join(leaseDir(directory, tasksDir), "owner.json")

/** Stale threshold: several missed heartbeats, floored so slow ticks don't cause takeover storms. */
export const staleThresholdMs = (intervalMs: number): number => Math.max(3 * intervalMs, 120_000)

/** Whether an owner record reads as dead. A missing/garbled record is stale (safe to take over). Pure. */
export const isLeaseStale = (owner: LeaseOwner | null, now: Date, staleMs: number): boolean => {
  if (!owner) return true
  const beat = Date.parse(owner.heartbeatAt)
  if (!Number.isFinite(beat)) return true
  return now.getTime() - beat > staleMs
}

/** Read and validate the current owner record; null when absent or unparseable. */
export const readLeaseOwner = async ($: Shell, directory: string, tasksDir: string): Promise<LeaseOwner | null> => {
  const out = await $`cat ${ownerFile(directory, tasksDir)}`.quiet().nothrow()
  if (out.exitCode !== 0) return null
  try {
    const parsed: unknown = JSON.parse(out.stdout.toString())
    const o = parsed as Partial<LeaseOwner>
    if (typeof o.pid !== "number" || typeof o.heartbeatAt !== "string") return null
    return {
      pid: o.pid,
      host: typeof o.host === "string" ? o.host : "unknown",
      startedAt: typeof o.startedAt === "string" ? o.startedAt : o.heartbeatAt,
      heartbeatAt: o.heartbeatAt,
      intervalMs: typeof o.intervalMs === "number" ? o.intervalMs : 0,
    }
  } catch {
    return null
  }
}

const writeOwner = async ($: Shell, directory: string, tasksDir: string, owner: LeaseOwner): Promise<void> => {
  await $`printf '%s' ${JSON.stringify(owner)} > ${ownerFile(directory, tasksDir)}`.quiet().nothrow()
}

/**
 * Acquire the clone's watch lease. Wins the atomic `mkdir`, or takes over a
 * stale lease by atomically renaming the stale dir aside (see below) before
 * recreating it. On refusal, returns the live (or takeover-winning) owner so the
 * caller can say who holds it.
 */
export const acquireLease = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  owner: { readonly pid: number; readonly host: string; readonly intervalMs: number },
  now: Date,
): Promise<AcquireResult> => {
  const dir = leaseDir(directory, tasksDir)
  const record: LeaseOwner = {
    ...owner,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
  }
  await $`mkdir -p ${path.dirname(dir)}`.quiet().nothrow()
  const won = await $`mkdir ${dir}`.quiet().nothrow()
  if (won.exitCode === 0) {
    await writeOwner($, directory, tasksDir, record)
    return { ok: true }
  }
  const current = await readLeaseOwner($, directory, tasksDir)
  if (isLeaseStale(current, now, staleThresholdMs(current?.intervalMs || owner.intervalMs))) {
    // Take over atomically. The old `rm -rf ${dir}` + `mkdir ${dir}` was NOT
    // atomic: two processes that both saw the same stale owner could each remove
    // the other's freshly-created dir and both believe they won. Instead, rename
    // the stale dir to a per-process-unique path — `mv` (rename) of one source is
    // atomic, so the FIRST taker moves it and every other taker's `mv` fails
    // because the source is already gone. Only the mover proceeds to recreate.
    const graveyard = `${dir}.dead-${owner.pid}-${now.getTime()}`
    const claimed = await $`mv ${dir} ${graveyard}`.quiet().nothrow()
    if (claimed.exitCode !== 0) {
      // Lost the rename race (or the owner refreshed/released) — report who holds it now.
      return { ok: false, owner: await readLeaseOwner($, directory, tasksDir) }
    }
    await $`rm -rf ${graveyard}`.quiet().nothrow()
    const retry = await $`mkdir ${dir}`.quiet().nothrow()
    if (retry.exitCode === 0) {
      await writeOwner($, directory, tasksDir, record)
      return { ok: true }
    }
    // A fresh acquirer created the lease between our rename and mkdir — they hold it.
    return { ok: false, owner: await readLeaseOwner($, directory, tasksDir) }
  }
  return { ok: false, owner: current }
}

/**
 * Refresh the lease's heartbeat, preserving its `startedAt`. Best-effort.
 * Writes ONLY while this process still owns the lease — a watcher that was
 * judged stale and taken over must not resurrect and clobber the new owner's
 * record (T3). Returns whether the heartbeat landed.
 */
export const heartbeatLease = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  owner: { readonly pid: number; readonly host: string; readonly intervalMs: number },
  now: Date,
): Promise<boolean> => {
  const current = await readLeaseOwner($, directory, tasksDir)
  if (!current || current.pid !== owner.pid || current.host !== owner.host) return false
  await writeOwner($, directory, tasksDir, {
    ...owner,
    startedAt: current.startedAt,
    heartbeatAt: now.toISOString(),
  })
  return true
}

/** Drop the lease. Best-effort — callers release on unwatch/stop/dispose. */
export const releaseLease = async ($: Shell, directory: string, tasksDir: string): Promise<void> => {
  await $`rm -rf ${leaseDir(directory, tasksDir)}`.quiet().nothrow()
}
