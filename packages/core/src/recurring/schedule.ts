import { Cron } from "croner"
import type { RecurringSchedule } from "./schema.js"

/**
 * The zone a cron expression is read in when the definition names none.
 *
 * **UTC, deliberately not the host's local zone.** Definition files are
 * committed to the repo and polled by whichever machine happens to be watching
 * — a laptop in one zone today, a runner in another tomorrow. Inheriting the
 * host's zone would make one committed schedule mean different wall-clock times
 * per machine, which surfaces as "the Monday job ran at 01:00" hours after the
 * fact. A definition that genuinely wants local time says so with `timezone`.
 */
export const CRON_DEFAULT_TIMEZONE = "UTC"

/** The zone this schedule's expression is evaluated in. Pure. */
const cronTimezone = (schedule: Extract<RecurringSchedule, { type: "cron" }>): string =>
  schedule.timezone ?? CRON_DEFAULT_TIMEZONE

/**
 * When a recurring definition next comes due, and whether it is due now.
 *
 * **Nothing here is persisted.** The ledger records only when a cycle last RAN
 * (`lastRunAt`); the next due time is always recomputed from that plus the
 * definition's current schedule. A stored `nextDueAt` would silently keep the
 * OLD cadence after a human edits the schedule — the edit would appear to do
 * nothing until one more cycle happened to run. Deriving it makes an edit take
 * effect on the very next poll.
 */

/**
 * The moment `schedule` next fires, given when it last ran. A definition that
 * has never run is due IMMEDIATELY (`now`) under both forms: authoring a
 * recurring task is the request to start running it, and making the human wait
 * out a full interval before the first cycle reads as a broken feature.
 *
 * An unparseable cron expression yields `null` — the caller reports it as a
 * broken definition rather than treating it as due (a throwing schedule would
 * take the whole poll down with it, starving every other definition).
 *
 * Pure given `now`.
 */
export const nextDueAt = (schedule: RecurringSchedule, lastRunAt: string | undefined, now: Date): Date | null => {
  const last = lastRunAt ? new Date(Date.parse(lastRunAt)) : null
  // A garbled lastRunAt reads as never-run rather than as the epoch: "due now"
  // is recoverable, a NaN comparison silently never fires again.
  const lastValid = last && Number.isFinite(last.getTime()) ? last : null
  // Validity is judged BEFORE the never-run shortcut below: an unusable
  // expression must never be "due", or a definition with a typo'd schedule
  // would fire on its first poll and again on every poll after it — the
  // loudest possible failure for the quietest possible mistake.
  if (schedule.type === "cron" && scheduleError(schedule)) return null
  // Never run ⇒ due immediately, under BOTH forms. Authoring a recurring order
  // is the request to start running it; waiting out a full interval — or worse,
  // until next Monday — before the first cycle reads as a broken feature.
  if (!lastValid) return now
  if (schedule.type === "interval") return new Date(lastValid.getTime() + schedule.minutes * 60_000)
  try {
    // croner computes the next fire STRICTLY after the reference instant, so
    // passing lastRunAt (not now) is what makes a missed window fire late
    // rather than being skipped — a watcher that was off overnight still runs
    // this morning's 09:00 job when it comes back up.
    return new Cron(schedule.expression, { timezone: cronTimezone(schedule) }).nextRun(lastValid)
  } catch {
    return null
  }
}

/** Whether `schedule` is due to fire at `now`. Pure. */
export const isDue = (schedule: RecurringSchedule, lastRunAt: string | undefined, now: Date): boolean => {
  const due = nextDueAt(schedule, lastRunAt, now)
  return due !== null && due.getTime() <= now.getTime()
}

/**
 * Validate a schedule at AUTHORING time, returning a human-readable reason it
 * is unusable, or null when it is fine. Kept separate from the zod schema on
 * purpose: a definition file carrying a typo'd cron expression must still
 * PARSE, so it can be listed and reported as broken rather than disappearing
 * from every listing behind a swallowed parse error.
 */
export const scheduleError = (schedule: RecurringSchedule): string | null => {
  if (schedule.type === "interval") {
    return schedule.minutes > 0 ? null : "interval minutes must be a positive whole number"
  }
  try {
    const job = new Cron(schedule.expression, { timezone: cronTimezone(schedule) })
    const next = job.nextRun()
    job.stop()
    return next ? null : `cron expression "${schedule.expression}" never fires`
  } catch (err) {
    return `invalid cron expression "${schedule.expression}" — ${(err as Error).message}`
  }
}

/** Render a schedule for a human (`every 60m`, `cron 0 9 * * MON`). Pure. */
export const describeSchedule = (schedule: RecurringSchedule): string =>
  schedule.type === "interval"
    ? `every ${String(schedule.minutes)}m`
    : `cron ${schedule.expression} (${cronTimezone(schedule)})`

/**
 * Parse the schedule half of an authoring command's arguments:
 * `--interval 90` / `--interval 2h` / `--cron "0 9 * * MON"`.
 *
 * Returns the schedule and the REMAINING text (the idea/title), so a caller can
 * accept the flags in any position without the human having to quote the idea.
 * Pure.
 */
export const parseScheduleArgs = (
  args: string,
): { schedule?: RecurringSchedule; rest: string } | { error: string } => {
  const cron = /(^|\s)--cron\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(args)
  const interval = /(^|\s)--interval\s+(\S+)/.exec(args)
  if (cron && interval) return { error: "Use either --interval or --cron, not both." }
  if (cron) {
    const expression = (cron[2] ?? cron[3] ?? cron[4] ?? "").trim()
    const schedule: RecurringSchedule = { type: "cron", expression }
    const err = scheduleError(schedule)
    if (err) return { error: err }
    return { schedule, rest: args.replace(cron[0], " ").trim() }
  }
  if (interval) {
    const raw = (interval[2] ?? "").trim()
    const minutes = parseIntervalMinutes(raw)
    if (minutes === null) {
      return { error: `Unrecognized interval "${raw}" — use minutes (90), or a unit suffix (30m, 2h, 1d).` }
    }
    const schedule: RecurringSchedule = { type: "interval", minutes }
    return { schedule, rest: args.replace(interval[0], " ").trim() }
  }
  return { rest: args.trim() }
}

/** `90` → 90, `30m` → 30, `2h` → 120, `1d` → 1440. Null when unparseable. Pure. */
export const parseIntervalMinutes = (spec: string): number | null => {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(spec.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (m[2] ?? "m").toLowerCase()
  const minutes = unit === "h" ? value * 60 : unit === "d" ? value * 1440 : value
  const rounded = Math.round(minutes)
  return rounded > 0 ? rounded : null
}
