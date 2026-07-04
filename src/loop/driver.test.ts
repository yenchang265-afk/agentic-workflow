import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePlanArgs, parseWatchArgs } from "./driver.ts"

/**
 * The watch-mode plumbing (timers, idle queries, claiming) is exercised
 * manually against a live opencode; the pure interval parser is unit-tested
 * here — it's the part with real input-space corners.
 */

test("an empty spec means 'use the config default'", () => {
  assert.deepEqual(parseWatchArgs(""), {})
  assert.deepEqual(parseWatchArgs("   "), {})
})

test("unit suffixes: seconds, minutes, hours", () => {
  assert.deepEqual(parseWatchArgs("30s"), { intervalMs: 30_000 })
  assert.deepEqual(parseWatchArgs("5m"), { intervalMs: 300_000 })
  assert.deepEqual(parseWatchArgs("2h"), { intervalMs: 7_200_000 })
})

test("a bare number is minutes", () => {
  assert.deepEqual(parseWatchArgs("5"), { intervalMs: 300_000 })
})

test("an --interval prefix is accepted", () => {
  assert.deepEqual(parseWatchArgs("--interval 5m"), { intervalMs: 300_000 })
})

test("case and internal whitespace are tolerated", () => {
  assert.deepEqual(parseWatchArgs("10 M"), { intervalMs: 600_000 })
})

test("sub-10s intervals clamp to the 10s floor", () => {
  assert.deepEqual(parseWatchArgs("1s"), { intervalMs: 10_000 })
  assert.deepEqual(parseWatchArgs("0.05"), { intervalMs: 10_000 })
})

test("garbage yields an error, not a silent default", () => {
  for (const bad of ["soon", "5x", "-5m", "m", "5m extra"]) {
    const parsed = parseWatchArgs(bad)
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(bad)}`)
  }
})

/**
 * `/loop-plan` argument classification: `approve`/`task` get plugin work,
 * everything else passes through to the agent turn.
 */

test("approve and task subcommands are recognized with their id", () => {
  assert.deepEqual(parsePlanArgs("approve my-task"), { mode: "approve", id: "my-task" })
  assert.deepEqual(parsePlanArgs("task my-task"), { mode: "task", id: "my-task" })
})

test("casing and surrounding whitespace are tolerated, ids keep their case", () => {
  assert.deepEqual(parsePlanArgs("  Approve My-Task  "), { mode: "approve", id: "My-Task" })
  assert.deepEqual(parsePlanArgs("TASK  my-task"), { mode: "task", id: "my-task" })
})

test("a bare subcommand keeps an empty id for the usage toast", () => {
  assert.deepEqual(parsePlanArgs("approve"), { mode: "approve", id: "" })
  assert.deepEqual(parsePlanArgs("task   "), { mode: "task", id: "" })
})

test("new and free text pass through", () => {
  assert.deepEqual(parsePlanArgs("new add rate limiting"), { mode: "passthrough" })
  assert.deepEqual(parsePlanArgs(""), { mode: "passthrough" })
  assert.deepEqual(parsePlanArgs("tasky thing"), { mode: "passthrough" })
})
