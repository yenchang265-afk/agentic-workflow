import path from "node:path"
import type { Log, Shell } from "./host.js"

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
 * The stale window for a claim whose stage may hold it for a full stage timeout
 * without writing any durable progress.
 *
 * `STALE_CLAIM_MINUTES` alone only ever covered claim→first-durable-progress,
 * which is right for BUILD (it writes a `> BUILD started` note early). PLAN
 * writes nothing until it parks the plan, so its entire runtime has to fit
 * inside the window — and `stageTimeoutMinutes` defaults to 60, four times the
 * constant. A 25-minute PLAN therefore had its marker swept by any other
 * process's startup sweep (`isDriving` is per-process, so that process sees no
 * live loop), a second PLAN claimed the same task, and both appended an
 * `## Implementation Plan` to one file — where `extractPlan` reads only the
 * last, silently discarding a run's work.
 *
 * So the window is the timeout PLUS the original margin: long enough that a
 * healthy stage can never be judged dead, still bounded so a crashed one
 * recovers without a human.
 */
export const staleClaimMinutes = (stageTimeoutMinutes: number): number =>
  Math.max(STALE_CLAIM_MINUTES, stageTimeoutMinutes + STALE_CLAIM_MINUTES)

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
 * Release `markerDir`, if present. Best-effort but never SILENTLY partial. The
 * stamp goes first — `rmdir` (kept over `rm -rf` for blast-radius reasons)
 * needs the marker empty — along with any `claim.json.tmp-*` temporaries the
 * atomic restamp can leave behind on a crash. A failed `rmdir` used to go
 * unchecked: the marker survived with no owner, and for an in-progress task
 * that never self-heals (`isOrphanedClaim` requires `isClaimable`, false once
 * the CLAIMED note lands) — every gate verb refused on the wedged marker until
 * a human ran doctor fix. Now the failure is at least LOUD when a log is
 * passed.
 */
export const releaseMarker = async ($: Shell, markerDir: string, log?: Log): Promise<void> => {
  await $`rm -f ${stampPath(markerDir)} ${stampPath(markerDir)}.tmp-*`.quiet().nothrow()
  const out = await $`rmdir ${markerDir}`.quiet().nothrow()
  if (out.exitCode === 0) return
  if ((await $`test -d ${markerDir}`.quiet().nothrow()).exitCode !== 0) return // already gone — released by someone else
  await log?.(
    "warn",
    `claim-marker: could not release ${markerDir} — it still holds foreign entries; gate verbs will refuse this task until doctor fix clears it`,
  )
}

/**
 * Refresh a held marker's stamp to `now`. Called at every stage boundary of a
 * multi-stage run: `staleClaimMinutes` covers a single stage's worst case, but a
 * whole BUILD→VERIFY→REVIEW loop can legitimately outlive it — without the
 * refresh, a live run's marker eventually reads as stale and a sweep hands its
 * task to a second claimer. No-op when the marker is absent (never re-creates a
 * released claim).
 */
/** Uniquifies concurrent restamp temp files within one process — N overlapped
 *  passes restamp the same marker, and a shared `.tmp-<pid>` would tear. */
let stampSeq = 0

export const restampMarker = async ($: Shell, markerDir: string, now: Date = new Date()): Promise<void> => {
  const held = await $`test -d ${markerDir}`.quiet().nothrow()
  if (held.exitCode !== 0) return
  // Temp + rename, never truncate-in-place: a concurrent `markerOlderThan`
  // `cat` landing mid-truncate fails to parse and falls back to the marker
  // DIRECTORY's mtime — which an in-place overwrite never advances, so it is
  // still claim-creation time and a LIVE long run reads stale, gets swept, and
  // a second drive starts on the same branch. (acquireMarker's plain write is
  // fine: a brand-new dir's mtime IS the claim time.) The trailing `touch`
  // keeps the mtime fallback honest for stamps a crash left garbled.
  const tmp = `${stampPath(markerDir)}.tmp-${process.pid}-${++stampSeq}`
  await $`printf '%s' ${JSON.stringify({ claimedAt: now.toISOString() })} > ${tmp}`.quiet().nothrow()
  await $`mv ${tmp} ${stampPath(markerDir)}`.quiet().nothrow()
  await $`touch ${markerDir}`.quiet().nothrow()
}

/**
 * Atomically release `markerDir` iff it is stale. The non-atomic shape this
 * replaces (`judge stale` → `rm -f stamp` → `rmdir`) let two sweepers judge the
 * SAME stale marker and the slower one delete a rival's brand-new claim created
 * in between — so the release renames the marker ASIDE first (rename of one
 * source is atomic: exactly one mover wins), re-judges what it moved, and puts
 * a fresh claim straight back. True only when this caller removed a stale
 * marker; false when the marker was fresh, absent, or someone else won the move.
 */
export const releaseMarkerIfStale = async ($: Shell, markerDir: string, minutes: number, now: Date = new Date()): Promise<boolean> => {
  if (!(await markerOlderThan($, markerDir, minutes, now))) return false
  const graveyard = `${markerDir}.dead-${process.pid}-${now.getTime()}`
  const moved = await $`mv ${markerDir} ${graveyard}`.quiet().nothrow()
  if (moved.exitCode !== 0) return false // lost the rename race — whoever moved it owns the sweep
  if (!(await markerOlderThan($, graveyard, minutes, now))) {
    // What we moved aside was a live claim, created between our judgement and
    // our rename. Put it back; a claim that is still running must survive.
    const restored = await $`mv ${graveyard} ${markerDir}`.quiet().nothrow()
    if (restored.exitCode !== 0) await $`rm -rf ${graveyard}`.quiet().nothrow() // someone re-took the path — drop our copy rather than leave debris
    // A zero exit does NOT prove the restore landed AS the marker: POSIX `mv`
    // onto a directory that exists again (a rival re-claimed the path inside
    // our window) nests the source INSIDE it instead of failing — and that
    // debris makes the rival's own stamp-then-rmdir release fail forever, a
    // held claim with no owner. Same positive confirmation scheduler/lease.ts
    // applies to its staging rename: the rival won the path, its claim
    // stands, our copy goes.
    const nested = path.join(markerDir, path.basename(graveyard))
    if ((await $`test -d ${nested}`.quiet().nothrow()).exitCode === 0) await $`rm -rf ${nested}`.quiet().nothrow()
    return false
  }
  await $`rm -rf ${graveyard}`.quiet().nothrow()
  return true
}

/**
 * Whether `markerDir` exists and is older than `minutes`. Judged from the
 * `claim.json` stamp when present; markers from older versions carry no stamp
 * and fall back to `find -mmin +N`, which prints the path only when strictly
 * older (GNU and BSD). Any failure — marker absent, or a `find` without `-mmin`
 * semantics — reads as "not stale", degrading safely to "marker stays held".
 */
/**
 * Win `markerDir`, sweeping it first when a dead claimer left it behind.
 *
 * The sweep used to be `rmdir` + re-acquire, which is NOT atomic: two processes
 * that judged the SAME stale marker each removed whatever was there at that
 * moment — including the other's brand-new marker — and both believed they had
 * won. Two sitters then drove one PR, both pushing the same head and both
 * writing the ledger at `onTerminal`. Reachable today with a watcher plus a
 * manual `claim`, which the watch lease does not gate.
 *
 * So the takeover renames the stale marker ASIDE, the idiom `scheduler/lease.ts`
 * uses for the same reason: rename of one source is atomic, so the first taker
 * moves it and every other taker's `mv` fails with the source already gone. The
 * moved-aside marker is then re-judged before it is discarded — if it turns out
 * to carry a FRESH stamp, a rival re-claimed inside the window and we moved a
 * live claim, so it goes straight back and this caller stands down.
 */
export const acquireOrSweepMarker = async ($: Shell, markerDir: string, minutes: number, now: Date = new Date()): Promise<boolean> => {
  if (await acquireMarker($, markerDir, now)) return true
  if (!(await releaseMarkerIfStale($, markerDir, minutes, now))) return false
  return acquireMarker($, markerDir, now)
}

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
