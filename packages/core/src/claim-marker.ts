import path from "node:path"
import type { Shell } from "./host.js"

/**
 * The mkdir-marker claim primitive, shared by every work source.
 *
 * A plain (non-recursive) `mkdir` of the marker either succeeds — claim won —
 * or fails because another watcher on this filesystem already holds it. That
 * much was always true of both marker families; what only the backlog had was a
 * way to RECOVER one. A sitter's marker was a bare mkdir/rmdir pair with no
 * stamp, no age check, and no sweep, so a SIGKILL or a throw that never reached
 * `onTerminal` left the marker on disk permanently and that PR / CI head /
 * dependency was never claimed again — recoverable only by a human `rm -rf`.
 *
 * So the stamp-and-staleness half lives here, keyed on a marker directory
 * rather than on a backlog `FileRef`, and both families use it.
 */

/**
 * A claim marker older than this, with no live loop behind it, is treated as
 * orphaned — its claimer died after winning the marker. Must exceed the
 * worst-case claim→first-durable-progress window, including a slow
 * `worktreeSetup` (e.g. npm ci).
 */
export const STALE_CLAIM_MINUTES = 15

/**
 * Staleness is judged from this stamp's `claimedAt`, never from fs mtime —
 * DrvFS/WSL mtime is unreliable, the same rule `scheduler/lease.ts` applies to
 * watch-lease liveness.
 */
export const stampPath = (markerDir: string): string => path.join(markerDir, "claim.json")

/** Win `markerDir` atomically and stamp it. False when someone already holds it. */
export const acquireMarker = async ($: Shell, markerDir: string, now: Date = new Date()): Promise<boolean> => {
  await $`mkdir -p ${path.dirname(markerDir)}`.quiet().nothrow()
  const out = await $`mkdir ${markerDir}`.quiet().nothrow()
  if (out.exitCode !== 0) return false
  // Best-effort, deliberately non-atomic: a torn or missing stamp only degrades
  // markerOlderThan to its mtime fallback, never to a wrong verdict from garbage.
  await $`printf '%s' ${JSON.stringify({ claimedAt: now.toISOString() })} > ${stampPath(markerDir)}`.quiet().nothrow()
  return true
}

/**
 * Release `markerDir`, if present. Best-effort. The stamp goes first — `rmdir`
 * (kept over `rm -rf` for blast-radius reasons) needs the marker empty; a crash
 * in between leaves a stamp-less marker the mtime fallback still sweeps.
 */
export const releaseMarker = async ($: Shell, markerDir: string): Promise<void> => {
  await $`rm -f ${stampPath(markerDir)}`.quiet().nothrow()
  await $`rmdir ${markerDir}`.quiet().nothrow()
}

/**
 * Whether `markerDir` exists and is older than `minutes`. Judged from the
 * `claim.json` stamp when present; markers from older versions carry no stamp
 * and fall back to `find -mmin +N`, which prints the path only when strictly
 * older (GNU and BSD). Any failure — marker absent, or a `find` without `-mmin`
 * semantics — reads as "not stale", degrading safely to "marker stays held".
 */
export const markerOlderThan = async ($: Shell, markerDir: string, minutes: number, now: Date = new Date()): Promise<boolean> => {
  const stamp = await $`cat ${stampPath(markerDir)}`.quiet().nothrow()
  if (stamp.exitCode === 0) {
    try {
      const { claimedAt } = JSON.parse(stamp.stdout.toString()) as { claimedAt?: unknown }
      if (typeof claimedAt === "string") {
        const at = Date.parse(claimedAt)
        if (!Number.isNaN(at)) return now.getTime() - at > minutes * 60_000
      }
    } catch {
      /* garbled stamp — fall through to the mtime check */
    }
  }
  const out = await $`find ${markerDir} -maxdepth 0 -mmin +${String(minutes)}`.quiet().nothrow()
  return out.exitCode === 0 && out.stdout.toString().trim().length > 0
}
