import assert from "node:assert/strict"
import { test } from "node:test"
import { decideVerdictGuard, nagMessage } from "./src/verdict-guard.mjs"

/**
 * The SubagentStop verdict guard: a check-stage subagent that stops without a
 * workflow_verdict call gets blocked exactly once with a reminder, then always
 * allowed (never trap an agent whose tool is genuinely unreachable — the MCP
 * server's no-verdict retry handles it from there).
 */

test("nags once for a check stage with no verdict recorded", () => {
  const marker = { stage: "verify", check: true, verdictRecorded: false }
  assert.equal(decideVerdictGuard(marker, false), "nag")
})

test("allows the second stop after the nag fired", () => {
  const marker = { stage: "verify", check: true, verdictRecorded: false }
  assert.equal(decideVerdictGuard(marker, true), "allow")
})

test("allows when the verdict was recorded", () => {
  const marker = { stage: "review", check: true, verdictRecorded: true }
  assert.equal(decideVerdictGuard(marker, false), "allow")
})

test("allows non-check stages and missing markers", () => {
  assert.equal(decideVerdictGuard({ stage: "build", check: false, verdictRecorded: false }, false), "allow")
  assert.equal(decideVerdictGuard({ stage: "build" }, false), "allow") // older server: no check field
  assert.equal(decideVerdictGuard(null, false), "allow")
})

test("an expired marker never nags — a crashed loop's leftover must not trap an unrelated subagent", () => {
  // Nothing removes the marker file when the MCP server dies mid-stage, and
  // writeStageMarker deletes the once-only sentinel on every arm — so a crashed
  // check stage's marker (check: true, verdictRecorded: false, deadline long
  // past) nagged the next ANY subagent to stop in the repo to call
  // workflow_verdict. Past-deadline reads as "this stage is over, live or
  // crashed" — the same reading spawn-guard gives the field.
  const dead = { stage: "review", check: true, verdictRecorded: false, deadline: 1_000 }
  assert.equal(decideVerdictGuard(dead, false, 2_000), "allow")
  // Inside the window the nag still fires, and a deadline-less older marker is untouched.
  assert.equal(decideVerdictGuard(dead, false, 500), "nag")
  assert.equal(decideVerdictGuard({ stage: "review", check: true, verdictRecorded: false }, false, 2_000), "nag")
})

test("nag message names the tool (both registered forms) and the stage", () => {
  const msg = nagMessage("verify")
  assert.match(msg, /workflow_verdict/)
  assert.match(msg, /mcp__agentic-workflow__workflow_verdict/)
  assert.match(msg, /mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict/)
  assert.match(msg, /VERIFY/)
  assert.match(msg, /stage: "verify"/)
})

test("the nag tells a subagent that is not the armed stage to record NOTHING", () => {
  // The stage here comes from the MARKER — the stage the loop armed — and this
  // guard cannot see which subagent is stopping. A subagent spawned out of step
  // would otherwise be told to record under the armed stage's name, and that call
  // IS accepted: a REVIEW's findings filed as the VERIFY verdict, which is worse
  // than the missing verdict the nag exists to prevent. check-spawn-stage now
  // blocks that spawn; this clause is the layer behind it.
  const msg = nagMessage("verify")
  assert.match(msg, /NOT the stage you were asked to run/)
  assert.match(msg, /record no verdict at all/)
})
