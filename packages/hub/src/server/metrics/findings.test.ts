import assert from "node:assert/strict"
import { test } from "node:test"
import { findingsStats } from "./findings.js"
import { runInput, sample, sidecarOf } from "./fixtures.js"

const finding = (detail: string, severity = "important") => ({
  axis: "correctness",
  verdict: "FAIL",
  findings: [{ severity, detail }],
})

test("findingsStats groups exact repeats (normalized) and counts severities", () => {
  const stats = findingsStats([
    runInput("a", "", sidecarOf([sample("review", { axes: [finding("Missing null check in pager")] })])),
    runInput("b", "", sidecarOf([sample("review", { axes: [finding("  missing null check in pager ")] })])),
    runInput("c", "", sidecarOf([sample("review", { axes: [finding("unrelated", "critical")] })])),
    runInput("d", "", null),
  ])

  assert.equal(stats.runsCovered, 3)
  assert.equal(stats.samplesWithFindings, 3)
  assert.deepEqual(stats.bySeverity, { important: 2, critical: 1 })
  const top = stats.topFindings[0]
  assert.ok(top)
  assert.equal(top.count, 2)
  // The first-seen original text is kept for display.
  assert.equal(top.detail, "Missing null check in pager")
  assert.deepEqual(top.stages, ["review"])
})

test("findingsStats namespaces stages by non-engineering kind", () => {
  const stats = findingsStats([
    runInput("a", "", sidecarOf([sample("verify", { axes: [finding("flaky test")] })], { kind: "pr-sitter" })),
  ])
  assert.deepEqual(stats.topFindings[0]?.stages, ["pr-sitter/verify"])
})

test("findingsStats is empty when no sample carries axes", () => {
  const stats = findingsStats([runInput("a", "", sidecarOf([sample("review", { verdict: "PASS" })]))])
  assert.equal(stats.runsCovered, 0)
  assert.deepEqual(stats.topFindings, [])
})
