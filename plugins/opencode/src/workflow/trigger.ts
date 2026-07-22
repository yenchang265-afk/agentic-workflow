import { Cron } from "croner"

/**
 * Watch-mode trigger strategies — how a watching session schedules claims
 * (see `LoopTrigger` in core's workflow/state.ts for the config surface):
 *
 * - poll: a standing interval timer (the safety net for missed idle events).
 * - cron: fire only when the schedule fires; plain idle events never claim.
 * - idle: no timer at all — the `session.idle` event stream alone drives
 *   claims, chaining loops back to back.
 *
 * Lease heartbeats are deliberately NOT tied to these timers: a cron kind may
 * be quiet for hours and an idle kind has no timer, so liveness runs on its
 * own fixed cadence in the driver.
 */

export type TriggerMode = "poll" | "cron" | "idle"

export interface WatchTimerHandle {
  readonly stop: () => void
  /** Human-readable cadence for toasts/status, e.g. "every 5m", "cron 0 9 * * 1-5". */
  readonly describe: string
}

/** Human-readable rendering of a polling cadence in ms. Pure. */
export const formatInterval = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`

/** Standing poll timer at a fixed cadence. */
export const armPoll = (intervalMs: number, tick: () => void): WatchTimerHandle => {
  const timer = setInterval(tick, intervalMs)
  return { stop: () => clearInterval(timer), describe: `every ${formatInterval(intervalMs)}` }
}

/** Cron-scheduled firing; `nextRun` is exposed via describe at arm time. */
export const armCron = (schedule: string, fire: () => void): WatchTimerHandle => {
  const job = new Cron(schedule, fire)
  const next = job.nextRun()
  return {
    stop: () => job.stop(),
    describe: `cron ${schedule}${next ? ` (next ${next.toLocaleString()})` : ""}`,
  }
}

/** No timer — the session.idle event stream alone drives claims. */
export const armIdle = (): WatchTimerHandle => ({ stop: () => {}, describe: "chaining on idle" })

/**
 * Whether a plain `session.idle` event may claim for this trigger mode. Cron
 * kinds claim only when the schedule fires — idle events would defeat the
 * schedule. Pure.
 */
export const claimsOnIdle = (mode: TriggerMode): boolean => mode !== "cron"

/** Throwing constructor check for a cron expression; returns the error message or null. Pure. */
export const cronError = (schedule: string): string | null => {
  try {
    new Cron(schedule).stop() // construct-only: validates syntax without scheduling anything
    return null
  } catch (err) {
    return (err as Error).message
  }
}
