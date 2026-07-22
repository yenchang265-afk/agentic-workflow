import assert from "node:assert/strict"
import { test } from "node:test"
import { formatDuration, formatTokens, renderRunSummary, type StageSample } from "./metrics.js"

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

test("renderRunSummary without token samples stays byte-identical to the legacy shape", () => {
  const out = renderRunSummary(clean, "done", "review passed", 3, "t")
  assert.ok(!out.includes("tokens"))
  assert.ok(!out.includes("cost"))
  assert.match(out, /\| # \| stage \| iter \| verdict \| wall-clock \|\n/)
})

test("renderRunSummary adds token and cost columns when any sample carries usage", () => {
  const withUsage: StageSample[] = [
    {
      stage: "build",
      iteration: 0,
      ms: 20_000,
      tokens: { input: 10_000, output: 1_800, reasoning: 200, cacheRead: 90_000, cacheWrite: 2_000 },
      cost: 0.1234,
      model: "claude-sonnet-5",
    },
    { stage: "verify", iteration: 0, ms: 16_000, verdict: "PASS" },
  ]
  const out = renderRunSummary(withUsage, "done", "", 3, "t")
  assert.match(out, /\| # \| stage \| iter \| verdict \| wall-clock \| tokens \| cost \|/)
  assert.match(out, /\| 1 \| build \| 1 \| — \| 20s \| 102\.0k\/2\.0k \| \$0\.1234 \|/)
  assert.match(out, /\| 2 \| verify \| 1 \| PASS \| 16s \| — \| — \|/)
  assert.match(out, /cost: \$0\.1234 · outcome: done/)
})

test("formatTokens scales counts", () => {
  assert.equal(formatTokens(456), "456")
  assert.equal(formatTokens(12_345), "12.3k")
  assert.equal(formatTokens(2_100_000), "2.1M")
})
