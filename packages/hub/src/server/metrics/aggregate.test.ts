import assert from "node:assert/strict"
import { test } from "node:test"
import { aggregateMetrics } from "./aggregate.js"
import { row, runInput, summary } from "./fixtures.js"

/**
 * The unit-of-analysis test, and the reason it comes first: one `runs/<id>.md`
 * holds a plan pass AND a build pass. Counting files instead of passes would
 * make every other number in the response wrong in the same direction, and
 * plausibly so.
 */
test("aggregateMetrics counts passes, not files", () => {
  const log =
    summary("done", [row(1, "plan", 1, "—", "1m 00s")], { used: 1, cap: 3 }) +
    summary("stopped", [row(1, "build", 1, "—", "20s")], { used: 3, cap: 3 })
  const m = aggregateMetrics([runInput("fix-bar", log)], [])

  assert.equal(m.runsTotal, 1)
  assert.equal(m.runsWithSummary, 1)
  assert.equal(m.passesTotal, 2)
  assert.deepEqual(m.outcomes, { done: 1, stopped: 1 })
})

test("aggregateMetrics counts a log with no terminal summary in runsTotal only", () => {
  const stageOnly = "\n## build · iteration 1 · 2026-07-06T10:00:00.000Z\n\nbuilt it\n"
  const m = aggregateMetrics([runInput("in-flight", stageOnly)], [])

  assert.equal(m.runsTotal, 1)
  assert.equal(m.runsWithSummary, 0)
  assert.equal(m.passesTotal, 0)
  assert.deepEqual(m.outcomes, {})
  // No passes → no denominators. Every rate is unmeasurable, NOT zero.
  assert.equal(m.burn.capTripRate, null)
  assert.equal(m.firstPass.rate, null)
  assert.equal(m.cache.ratio, null)
})

test("aggregateMetrics reports unknown outcome words rather than dropping them", () => {
  const m = aggregateMetrics([runInput("odd", summary("abandoned", [row(1, "build", 1, "—", "5s")]))], [])
  assert.deepEqual(m.outcomes, { abandoned: 1 })
})

// --- iteration burn ---------------------------------------------------------

test("burn measures only passes whose footer recorded a cap", () => {
  const measured =
    summary("done", [row(1, "verify", 1, "PASS", "10s")], { used: 1, cap: 3 }) +
    summary("stopped", [row(1, "verify", 3, "FAIL", "10s")], { used: 3, cap: 3 })
  const footerless = summary("done", [row(1, "verify", 1, "PASS", "10s")])
  const m = aggregateMetrics([runInput("a", measured), runInput("b", footerless)], [])

  assert.equal(m.passesTotal, 3)
  assert.equal(m.burn.passesMeasured, 2)
  assert.equal(m.burn.passesUnmeasured, 1)
  assert.equal(m.burn.cappedPasses, 1)
  assert.equal(m.burn.capTripRate, 0.5)
  // 1/3 ≈ 0.333 and 3/3 = 1.0 — the footer-less pass must not appear anywhere.
  const total = m.burn.buckets.reduce((sum, b) => sum + b.passes, 0)
  assert.equal(total, 2)
  assert.equal(m.burn.buckets.find((b) => b.from === 0)?.passes, 0)
  assert.equal(m.burn.buckets.find((b) => b.from === 0.25)?.passes, 1)
  assert.equal(m.burn.buckets.find((b) => b.from === 1)?.passes, 1)
})

test("burn is unmeasurable, not zero, when no pass recorded a cap", () => {
  const m = aggregateMetrics([runInput("a", summary("done", [row(1, "verify", 1, "PASS", "10s")]))], [])
  assert.equal(m.burn.passesMeasured, 0)
  assert.equal(m.burn.meanRatio, null)
  assert.equal(m.burn.medianRatio, null)
  assert.equal(m.burn.capTripRate, null)
})

// --- first-pass yield -------------------------------------------------------

test("first-pass yield counts only passes carrying a real verdict", () => {
  const clean = summary("done", [row(1, "build", 1, "—", "20s"), row(2, "verify", 1, "PASS", "10s")])
  const retried = summary("done", [row(1, "verify", 1, "FAIL", "10s"), row(2, "verify", 2, "PASS", "10s")])
  const noChecks = summary("done", [row(1, "plan", 1, "—", "1m 00s")])
  const declined = summary("done", [row(1, "verify", 1, "none", "10s")])
  const m = aggregateMetrics(
    [runInput("a", clean), runInput("b", retried), runInput("c", noChecks), runInput("d", declined)],
    [],
  )

  assert.equal(m.firstPass.passesMeasured, 2)
  // A `—` verdict (build) and a `none` verdict (declined to judge) are both
  // absences of a judgement — neither can make a pass clean or unclean.
  assert.equal(m.firstPass.passesWithoutChecks, 2)
  assert.equal(m.firstPass.cleanPasses, 1)
  assert.equal(m.firstPass.rate, 0.5)
})

test("first-pass yield rejects a pass that needed a second iteration on any check", () => {
  // Verify passes first time, review fails and forces iteration 2. Not clean.
  const mixed = summary("done", [
    row(1, "verify", 1, "PASS", "10s"),
    row(2, "review", 1, "FAIL", "30s"),
    row(3, "build", 2, "—", "20s"),
    row(4, "review", 2, "PASS", "30s"),
  ])
  const m = aggregateMetrics([runInput("a", mixed)], [])
  assert.equal(m.firstPass.passesMeasured, 1)
  assert.equal(m.firstPass.cleanPasses, 0)
  assert.equal(m.firstPass.rate, 0)
})

// --- durations --------------------------------------------------------------

/**
 * The silent-zero guard. `parseDuration` returns 0 for anything it cannot read,
 * including `—`, so averaging raw `seconds` would quietly drag every stage mean
 * down and look like a performance win.
 */
test("durations skip unparseable wall-clock cells instead of averaging them as zero", () => {
  const log = summary("done", [
    row(1, "verify", 1, "PASS", "20s"),
    row(2, "verify", 2, "PASS", "2m 41s"),
    row(3, "verify", 3, "PASS", "—"),
  ])
  const m = aggregateMetrics([runInput("a", log)], [])
  const verify = m.durations.find((d) => d.stage === "verify")

  assert.equal(verify?.rows, 2)
  assert.equal(verify?.meanSeconds, 90.5) // (20 + 161) / 2 — NOT (20 + 161 + 0) / 3
  assert.equal(verify?.maxSeconds, 161)
  // The skipped row still counts as a verdict — only the duration roll-up drops it.
  assert.equal(m.verdicts.find((v) => v.stage === "verify")?.pass, 3)
})

test("durations report median separately from mean", () => {
  const log = summary("done", [
    row(1, "build", 1, "—", "10s"),
    row(2, "build", 2, "—", "20s"),
    row(3, "build", 3, "—", "5m 00s"),
  ])
  const build = aggregateMetrics([runInput("a", log)], []).durations.find((d) => d.stage === "build")
  assert.equal(build?.medianSeconds, 20)
  assert.equal(build?.meanSeconds, 110) // (10 + 20 + 300) / 3
})

// --- passthrough ------------------------------------------------------------

test("aggregateMetrics passes skipped run ids through verbatim", () => {
  const m = aggregateMetrics([], ["unreadable-run"])
  assert.deepEqual(m.skippedRuns, ["unreadable-run"])
  assert.equal(m.runsTotal, 0)
})
