import assert from "node:assert/strict"
import { test } from "node:test"
import { formatDuration, renderRunSummary, type StageSample } from "./metrics.js"

test("formatDuration renders sub-minute, minute, and hour scales", () => {
  assert.equal(formatDuration(45_000), "45s")
  assert.equal(formatDuration(161_000), "2m 41s")
  assert.equal(formatDuration(3_780_000), "1h 03m")
  assert.equal(formatDuration(0), "0s")
})

const clean: StageSample[] = [
  { stage: "build", iteration: 0, ms: 665_000 },
  { stage: "verify", iteration: 0, ms: 181_000, verdict: "PASS" },
  { stage: "review", iteration: 0, ms: 259_000, verdict: "PASS" },
]

test("renderRunSummary tabulates stages and reports iterations used", () => {
  const out = renderRunSummary(clean, "done", "review passed", 3, "2026-07-04T10:00:00.000Z")
  assert.match(out, /## Run summary · done: review passed · 2026-07-04T10:00:00\.000Z/)
  assert.match(out, /\| 1 \| build \| 1 \| — \| 11m 05s \|/)
  assert.match(out, /\| 2 \| verify \| 1 \| PASS \| 3m 01s \|/)
  assert.match(out, /iterations used: 1\/3/)
  assert.match(out, /total: 18m 25s · outcome: done/)
})

test("renderRunSummary counts the highest iteration reached across a re-build run", () => {
  const reran: StageSample[] = [
    { stage: "verify", iteration: 0, ms: 1000, verdict: "FAIL" },
    { stage: "build", iteration: 1, ms: 1000 },
    { stage: "verify", iteration: 1, ms: 1000, verdict: "PASS" },
  ]
  assert.match(renderRunSummary(reran, "done", "", 3, "t"), /iterations used: 2\/3/)
})

test("renderRunSummary labels review-lens passes", () => {
  const lensed: StageSample[] = [
    { stage: "review", iteration: 0, ms: 1000, verdict: "PASS", lens: "security" },
    { stage: "review", iteration: 0, ms: 1000, verdict: "FAIL", lens: "correctness" },
  ]
  const out = renderRunSummary(lensed, "stopped", "review failed", 3, "t")
  assert.match(out, /review \(security\)/)
  assert.match(out, /review \(correctness\)/)
})

test("renderRunSummary handles an empty sample list (crash before any stage)", () => {
  const out = renderRunSummary([], "error", "worktree add failed", 3, "t")
  assert.match(out, /\(no stages ran\)/)
  assert.match(out, /iterations used: 0\/3/)
  assert.match(out, /total: 0s/)
})
