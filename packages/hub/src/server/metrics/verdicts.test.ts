import assert from "node:assert/strict"
import { test } from "node:test"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import { row, summary } from "./fixtures.js"
import { stageVerdicts, verdictFlips } from "./verdicts.js"

const passesOf = (...markdown: readonly string[]) => parseRunLog(markdown.join("")).summaries

test("stageVerdicts tallies each verdict in its own column", () => {
  const passes = passesOf(
    summary("done", [
      row(1, "verify", 1, "PASS", "10s"),
      row(2, "verify", 2, "FAIL", "10s"),
      row(3, "verify", 3, "ERROR", "10s"),
      row(4, "verify", 4, "none", "10s"),
    ]),
  )
  const verify = stageVerdicts(passes).find((v) => v.stage === "verify")

  assert.equal(verify?.pass, 1)
  assert.equal(verify?.fail, 1)
  assert.equal(verify?.error, 1)
  // `none` is the check declining to judge — it is not a failure.
  assert.equal(verify?.none, 1)
})

test("stageVerdicts ignores rows with no verdict at all", () => {
  const passes = passesOf(summary("done", [row(1, "build", 1, "—", "20s")]))
  assert.deepEqual(stageVerdicts(passes), [])
})

test("stageVerdicts merges a stage's lens variants into one row", () => {
  const passes = passesOf(
    summary("done", [
      row(1, "review (security)", 1, "PASS", "30s"),
      row(2, "review (performance)", 1, "FAIL", "30s"),
    ]),
  )
  const rows = stageVerdicts(passes)

  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.stage, "review")
  assert.equal(rows[0]?.pass, 1)
  assert.equal(rows[0]?.fail, 1)
})

/**
 * The sharpest case in the feature. Two review lenses run per iteration, so
 * keying the transition sequence by stage alone interleaves them: this fixture
 * would report a phantom PASS→FAIL between two rows of the SAME iteration.
 */
test("verdictFlips tracks each lens as its own sequence", () => {
  const passes = passesOf(
    summary("done", [
      row(1, "review (performance)", 1, "PASS", "30s"),
      row(2, "review (security)", 1, "FAIL", "30s"),
      row(3, "review (performance)", 2, "PASS", "30s"),
      row(4, "review (security)", 2, "PASS", "30s"),
    ]),
  )
  const flips = verdictFlips(passes)

  assert.equal(flips.failToPass, 1) // security recovered
  assert.equal(flips.passToFail, 0) // performance never regressed
  assert.equal(flips.passesWithFlips, 1)
})

test("verdictFlips counts a check that a re-build failed to move", () => {
  const passes = passesOf(
    summary("stopped", [row(1, "verify", 1, "FAIL", "10s"), row(2, "verify", 2, "FAIL", "10s")], {
      used: 2,
      cap: 2,
    }),
  )
  const flips = verdictFlips(passes)

  assert.equal(flips.failToFail, 1)
  assert.equal(flips.failToPass, 0)
  assert.equal(flips.passesWithFlips, 1)
})

test("verdictFlips sees a recovery across an intervening ERROR", () => {
  // An ERROR is an infra failure, not a judgement. A FAIL then a transient
  // ERROR then a PASS is still a fail→pass recovery — the ERROR must not consume
  // the adjacency and hide it.
  const passes = passesOf(
    summary("done", [
      row(1, "verify", 1, "FAIL", "10s"),
      row(2, "verify", 2, "ERROR", "2s"),
      row(3, "verify", 3, "PASS", "10s"),
    ]),
  )
  const flips = verdictFlips(passes)

  assert.equal(flips.failToPass, 1)
  assert.equal(flips.failToFail, 0)
  assert.equal(flips.passesWithFlips, 1)
})

test("verdictFlips never spans two passes in one log", () => {
  // A plan pass ending FAIL followed by a build pass opening PASS is not a
  // recovery — they are independent runs that happen to share a file.
  const passes = passesOf(
    summary("stopped", [row(1, "verify", 1, "FAIL", "10s")]),
    summary("done", [row(1, "verify", 1, "PASS", "10s")]),
  )
  const flips = verdictFlips(passes)

  assert.equal(flips.failToPass, 0)
  assert.equal(flips.passesWithFlips, 0)
})

test("verdictFlips reports nothing for a clean single-iteration pass", () => {
  const passes = passesOf(summary("done", [row(1, "verify", 1, "PASS", "10s")]))
  assert.deepEqual(verdictFlips(passes), { failToPass: 0, passToFail: 0, failToFail: 0, passesWithFlips: 0 })
})
