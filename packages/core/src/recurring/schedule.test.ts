import assert from "node:assert/strict"
import { test } from "node:test"
import {
  describeSchedule,
  isDue,
  nextDueAt,
  parseIntervalMinutes,
  parseScheduleArgs,
  scheduleError,
} from "./schedule.js"

/**
 * The due-date math, which is pure and is the whole scheduling contract: a
 * definition runs when `nextDueAt(schedule, lastRunAt) <= now`.
 */

const AT = (iso: string): Date => new Date(Date.parse(iso))

test("a definition that has never run is due immediately, under both schedule forms", () => {
  // Authoring a recurring order IS the request to start running it — making the
  // human wait out a full interval for the first cycle reads as broken.
  const now = AT("2026-07-05T12:00:00Z")
  assert.deepEqual(nextDueAt({ type: "interval", minutes: 1440 }, undefined, now), now)
  assert.deepEqual(nextDueAt({ type: "cron", expression: "0 9 * * MON" }, undefined, now), now)
  assert.equal(isDue({ type: "interval", minutes: 1440 }, undefined, now), true)
})

test("an interval counts forward from the last run", () => {
  const last = "2026-07-05T12:00:00Z"
  const due = nextDueAt({ type: "interval", minutes: 90 }, last, AT("2026-07-05T12:00:00Z"))
  assert.equal(due?.toISOString(), "2026-07-05T13:30:00.000Z")
  assert.equal(isDue({ type: "interval", minutes: 90 }, last, AT("2026-07-05T13:29:59Z")), false)
  assert.equal(isDue({ type: "interval", minutes: 90 }, last, AT("2026-07-05T13:30:00Z")), true)
})

test("a cron schedule fires at its next wall-clock occurrence after the last run", () => {
  // Monday 09:00; last ran the previous Monday.
  const last = "2026-07-06T09:00:00Z"
  const due = nextDueAt({ type: "cron", expression: "0 9 * * MON" }, last, AT("2026-07-06T09:00:00Z"))
  assert.equal(due?.toISOString(), "2026-07-13T09:00:00.000Z")
})

test("a cron expression defaults to UTC, not the host's local zone", () => {
  // A definition file is committed and polled from whichever machine is
  // watching; inheriting the host zone would make one schedule mean different
  // wall-clock times per machine. This test is what pins that — it fails on a
  // non-UTC host if the default is ever changed to local time.
  const due = nextDueAt({ type: "cron", expression: "0 9 * * MON" }, "2026-07-06T09:00:00Z", AT("2026-07-06T09:00:00Z"))
  assert.equal(due?.toISOString(), "2026-07-13T09:00:00.000Z")
})

test("an explicit timezone is honoured over the UTC default", () => {
  // 09:00 in Asia/Tokyo (UTC+9) is 00:00Z the same day.
  const due = nextDueAt(
    { type: "cron", expression: "0 9 * * MON", timezone: "Asia/Tokyo" },
    "2026-07-06T09:00:00Z",
    AT("2026-07-06T09:00:00Z"),
  )
  assert.equal(due?.toISOString(), "2026-07-13T00:00:00.000Z")
})

test("a missed cron window fires late rather than being skipped", () => {
  // The watcher was off for two weeks; the next poll must still run the job
  // once, not silently wait for a fresh occurrence.
  const last = "2026-07-06T09:00:00Z"
  const now = AT("2026-07-27T15:00:00Z")
  assert.equal(isDue({ type: "cron", expression: "0 9 * * MON" }, last, now), true)
})

test("a garbled lastRunAt reads as never-run, not as the epoch", () => {
  // A NaN comparison would silently never fire again; "due now" is recoverable.
  const now = AT("2026-07-05T12:00:00Z")
  assert.deepEqual(nextDueAt({ type: "interval", minutes: 60 }, "not-a-date", now), now)
})

test("an unusable cron expression yields null rather than throwing — and is never 'due now'", () => {
  // A throwing schedule would take the whole poll down and starve every other
  // definition; null lets the source report just this one as broken.
  //
  // The `undefined` lastRunAt case is the sharp one: it collides with the
  // never-run-is-due-immediately rule, so a typo'd expression would otherwise
  // fire on the first poll and every poll after it.
  const now = AT("2026-07-05T12:00:00Z")
  assert.equal(nextDueAt({ type: "cron", expression: "not a schedule" }, undefined, now), null)
  assert.equal(isDue({ type: "cron", expression: "not a schedule" }, undefined, now), false)
  assert.equal(isDue({ type: "cron", expression: "not a schedule" }, "2026-07-01T00:00:00Z", now), false)
})

test("scheduleError names what is wrong, and passes a valid schedule", () => {
  assert.equal(scheduleError({ type: "interval", minutes: 30 }), null)
  assert.equal(scheduleError({ type: "cron", expression: "0 9 * * MON" }), null)
  assert.match(scheduleError({ type: "cron", expression: "nope" }) ?? "", /invalid cron expression/)
})

test("parseIntervalMinutes accepts bare minutes and unit suffixes", () => {
  assert.equal(parseIntervalMinutes("90"), 90)
  assert.equal(parseIntervalMinutes("30m"), 30)
  assert.equal(parseIntervalMinutes("2h"), 120)
  assert.equal(parseIntervalMinutes("1d"), 1440)
  assert.equal(parseIntervalMinutes("0"), null)
  assert.equal(parseIntervalMinutes("soon"), null)
})

test("parseScheduleArgs splits the schedule flags from the idea text", () => {
  const a = parseScheduleArgs("--interval 2h Summarize merged PRs")
  assert.deepEqual(a, { schedule: { type: "interval", minutes: 120 }, rest: "Summarize merged PRs" })

  const b = parseScheduleArgs('Post the weekly digest --cron "0 9 * * MON"')
  assert.deepEqual(b, { schedule: { type: "cron", expression: "0 9 * * MON" }, rest: "Post the weekly digest" })
})

test("parseScheduleArgs reports a bad schedule instead of silently dropping it", () => {
  const bad = parseScheduleArgs("--cron nonsense do a thing")
  assert.ok("error" in bad && /cron/i.test(bad.error))
  const both = parseScheduleArgs('--interval 5 --cron "0 9 * * MON" x')
  assert.ok("error" in both && /not both/.test(both.error))
})

test("an idea with no schedule flag parses as all-idea, no schedule", () => {
  assert.deepEqual(parseScheduleArgs("just an idea"), { rest: "just an idea" })
})

test("describeSchedule renders both forms for humans, naming the zone", () => {
  assert.equal(describeSchedule({ type: "interval", minutes: 60 }), "every 60m")
  assert.equal(describeSchedule({ type: "cron", expression: "0 9 * * MON" }), "cron 0 9 * * MON (UTC)")
  assert.equal(
    describeSchedule({ type: "cron", expression: "0 9 * * MON", timezone: "Europe/London" }),
    "cron 0 9 * * MON (Europe/London)",
  )
})
