import assert from "node:assert/strict"
import { test } from "node:test"
import { parseConfig } from "../config.js"
import { armCron, armIdle, armPoll, claimsOnIdle, cronError, formatInterval } from "./trigger.js"

test("claimsOnIdle: poll and idle watchers claim on idle events, cron watchers don't", () => {
  assert.equal(claimsOnIdle("poll"), true)
  assert.equal(claimsOnIdle("idle"), true)
  assert.equal(claimsOnIdle("cron"), false)
})

test("cronError accepts real cron expressions and rejects junk", () => {
  assert.equal(cronError("*/15 * * * *"), null)
  assert.equal(cronError("0 9 * * 1-5"), null)
  assert.notEqual(cronError("not a cron"), null)
  assert.notEqual(cronError("99 99 * * *"), null)
})

test("armPoll ticks on its interval and stops cleanly", async () => {
  let ticks = 0
  const handle = armPoll(20, () => ticks++)
  assert.match(handle.describe, /^every /)
  await new Promise((r) => setTimeout(r, 90))
  handle.stop()
  const at = ticks
  assert.ok(at >= 2, `expected >=2 ticks, got ${at}`)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(ticks, at) // no ticks after stop
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for `done`, polling until a generous deadline rather than sleeping a fixed
 * span. A one-second cron only clears a fixed 1.1s sleep by ~100ms, and a loaded
 * CI runner starves timers by more than that — which failed the gate on a change
 * that touched nothing here. Polling keeps the test fast when the box is healthy
 * and merely slower, never red, when it is not.
 */
const waitFor = async (done: () => boolean, deadlineMs = 10_000): Promise<void> => {
  for (let waited = 0; waited < deadlineMs && !done(); waited += 25) await sleep(25)
}

test("armCron schedules against the expression and stops cleanly", async () => {
  let fires = 0
  const handle = armCron("* * * * * *", () => fires++) // croner seconds field
  assert.match(handle.describe, /^cron /)
  await waitFor(() => fires >= 1)
  handle.stop()
  const at = fires
  assert.ok(at >= 1, `expected >=1 fire, got ${at}`)
  // Still a real span, and one wide enough to cross a boundary the cron would
  // have fired on: this half proves stop() silenced it, so it cannot be polled.
  await sleep(1_100)
  assert.equal(fires, at) // no fires after stop
})

test("armIdle arms nothing and stop is a no-op", () => {
  const handle = armIdle()
  assert.equal(handle.describe, "chaining on idle")
  handle.stop()
})

test("formatInterval renders h/m/s", () => {
  assert.equal(formatInterval(3_600_000), "1h")
  assert.equal(formatInterval(300_000), "5m")
  assert.equal(formatInterval(30_000), "30s")
})

test("host config rejects an invalid cron schedule at load, names the path", () => {
  assert.throws(
    () => parseConfig({ workflows: { "pr-sitter": { enabled: true, trigger: { type: "cron", schedule: "junk" } } } }),
    /workflows\.pr-sitter\.trigger\.schedule/,
  )
  const ok = parseConfig({ workflows: { "pr-sitter": { enabled: true, trigger: { type: "cron", schedule: "*/15 * * * *" } } } })
  assert.deepEqual(ok.workflows["pr-sitter"]?.trigger, { type: "cron", schedule: "*/15 * * * *" })
})
