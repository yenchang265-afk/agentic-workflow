import os from "node:os"
import type { Shell } from "./host.js"

/**
 * Process liveness, shared by the two marker families that stamp their writer.
 *
 * Both the live-stage marker (`workflow/stage-marker.ts`) and the claim stamp
 * (`claim-marker.ts`) record the pid of the process that wrote them, so a
 * SIGKILLed writer's leftover marker reads dead immediately instead of pinning
 * its task for the rest of a wall-clock window. The probe was written twice
 * before this module existed; one copy is the point, because the EPERM caveat
 * below is the kind of detail that drifts.
 */

/**
 * Whether `pid` is CONFIRMED to be running on this machine. `kill -0` probes
 * existence without signalling.
 *
 * Note the asymmetry with `pidGone` below: false here means "not confirmed
 * alive", NOT "dead". An EPERM — the process exists but is owned by another
 * user — also exits non-zero. That is fine for callers who only ever relax a
 * guard on a false reading, which is why the stage marker can use this alone.
 */
export const pidAlive = async ($: Shell, pid: number): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const out = await $`kill -0 ${String(pid)}`.quiet().nothrow()
  return out.exitCode === 0
}

/**
 * Positive proof that `pid` is GONE on this machine.
 *
 * Never infers death from a bare `kill -0` failure. EPERM (alive, owned by
 * another user — a `sudo`-launched loop, a shared build box, a group-writable
 * clone) exits non-zero exactly like ESRCH, and here a false "gone" authorizes
 * a claim takeover, i.e. a SECOND drive on one `feature/<id>` branch. That is
 * the failure this whole mechanism exists to avoid, so death needs evidence,
 * not the absence of evidence.
 *
 * Every probe is SELF-VALIDATING: it must be able to see our own pid first, or
 * it proves nothing about anyone else's and the answer is "not proven gone". A
 * host where neither probe works therefore degrades to the wall-clock window
 * rather than to a wrong verdict.
 */
export const pidGone = async ($: Shell, pid: number): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (await pidAlive($, pid)) return false
  // Linux: /proc/<pid> is visible whoever owns the process, so absence is proof
  // — but only once /proc/<self> confirms the probe works in this environment
  // (a container without /proc mounted would otherwise read every pid as gone).
  if ((await $`test -d ${`/proc/${String(process.pid)}`}`.quiet().nothrow()).exitCode === 0) {
    return (await $`test -d ${`/proc/${String(pid)}`}`.quiet().nothrow()).exitCode !== 0
  }
  // Elsewhere (macOS/BSD): ask ps about the target AND ourselves in one call, so
  // a ps that reports nothing usable cannot be mistaken for an empty result.
  const out = await $`ps -o pid= -p ${`${String(pid)},${String(process.pid)}`}`.quiet().nothrow()
  const seen = new Set(
    out.stdout
      .toString()
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0),
  )
  return seen.has(String(process.pid)) && !seen.has(String(pid))
}

/**
 * This machine's identity, as stamped next to a pid.
 *
 * A pid is only meaningful inside the pid namespace that produced it, and a
 * marker directory can be shared across machines (an NFS/bind-mounted repo) or
 * across containers. Hostname alone is not enough there: two containers from
 * one image commonly share a hostname while having SEPARATE pid namespaces, and
 * a live foreign pid that happens not to exist locally would read "dead" — the
 * one way this design could authorize a false takeover. So the boot id joins
 * it: it is per-kernel-boot AND per-container on Linux, so a mismatch is
 * detected even when the hostnames agree.
 *
 * Read once — it cannot change within a process — and best-effort: on a host
 * without `/proc` the token degrades to the hostname, and a comparison against
 * a stamp carrying a boot id then MISMATCHES, which is the safe direction
 * ("unknown", i.e. today's wall-clock behaviour) rather than a false takeover.
 */
export interface MachineId {
  readonly host: string
  readonly boot: string | null
}

let cached: MachineId | null = null

export const machineId = async ($: Shell): Promise<MachineId> => {
  if (cached) return cached
  const out = await $`cat /proc/sys/kernel/random/boot_id`.quiet().nothrow()
  const boot = out.exitCode === 0 ? out.stdout.toString().trim() : ""
  cached = { host: os.hostname(), boot: boot.length > 0 ? boot : null }
  return cached
}

/** Test seam: drop the memoized machine id. Never called in production. */
export const resetMachineIdCache = (): void => void (cached = null)

/**
 * Whether a stamped `{ host, boot }` names the machine we are running on.
 *
 * Fails CLOSED — every uncertainty is "not ours":
 * - a stamp with no host (older versions) cannot be proven local;
 * - a host mismatch is another machine;
 * - a boot id present on one side and absent on the other is an unprovable
 *   comparison (a container boundary the hostname did not reveal, or a host
 *   whose `/proc` we could not read), so it is refused too.
 *
 * Pure.
 */
export const isSameMachine = (stamped: { host?: unknown; boot?: unknown }, self: MachineId): boolean => {
  if (typeof stamped.host !== "string" || stamped.host !== self.host) return false
  const stampedBoot = typeof stamped.boot === "string" && stamped.boot.length > 0 ? stamped.boot : null
  return stampedBoot === self.boot
}
