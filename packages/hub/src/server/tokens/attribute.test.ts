import assert from "node:assert/strict"
import { test } from "node:test"
import { addTokens, attribute, windowsFromSamples, windowsFromSummary, ZERO_TOKENS, type UsageRecord } from "./attribute.js"
import type { RunLogSummary } from "@agentic-workflow/core/workflow/runlog"

const T0 = Date.parse("2026-07-06T10:00:00.000Z")

const record = (offsetSec: number, input: number, output: number): UsageRecord => ({
  atMs: T0 + offsetSec * 1000,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
})

test("windowsFromSamples maps startedAt+ms and skips samples without an anchor", () => {
  const windows = windowsFromSamples([
    { stage: "build", iteration: 0, ms: 60_000, startedAt: "2026-07-06T10:00:00.000Z" },
    { stage: "verify", iteration: 0, ms: 30_000 },
  ])
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0], { stage: "build", iteration: 1, startMs: T0, endMs: T0 + 60_000 })
})

test("windowsFromSummary reconstructs sequential windows backwards from the stamp", () => {
  const summary: RunLogSummary = {
    outcome: "done",
    at: "2026-07-06T10:01:30.000Z", // 90s after T0
    rows: [
      { stage: "build", iteration: 1, duration: "60s", seconds: 60, extra: {} },
      { stage: "verify", iteration: 1, duration: "30s", seconds: 30, extra: {} },
    ],
  }
  const windows = windowsFromSummary(summary)
  assert.equal(windows.length, 2)
  assert.equal(windows[0]?.startMs, T0)
  assert.equal(windows[0]?.endMs, T0 + 60_000)
  assert.equal(windows[1]?.startMs, T0 + 60_000)
  assert.equal(windows[1]?.endMs, T0 + 90_000)
})

test("attribute sums records inside each window and drops windows with no hits", () => {
  const windows = windowsFromSummary({
    outcome: "done",
    at: "2026-07-06T10:01:30.000Z",
    rows: [
      { stage: "build", iteration: 1, duration: "60s", seconds: 60, extra: {} },
      { stage: "verify", iteration: 1, duration: "30s", seconds: 30, extra: {} },
    ],
  })
  const records = [record(10, 1000, 100), record(50, 2000, 200), record(75, 500, 50), record(500, 9999, 9999)]
  const rows = attribute(windows, records)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.window.stage, "build")
  assert.equal(rows[0]?.tokens.input, 3000)
  assert.equal(rows[0]?.tokens.output, 300)
  assert.equal(rows[1]?.window.stage, "verify")
  assert.equal(rows[1]?.tokens.input, 500)
})

test("addTokens sums componentwise from zero", () => {
  const t = addTokens(ZERO_TOKENS, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
  assert.deepEqual(t, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
})
