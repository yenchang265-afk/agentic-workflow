import assert from "node:assert/strict"
import { test } from "node:test"
import { stageOrderError } from "./stage-guard.ts"

// loop_stage arms the marker for the stage the state machine is AT — never a
// stage ahead of it. A mismatch means the orchestrator skipped loop_advance:
// the check subagent it is about to spawn would run to completion and then have
// its loop_verdict rejected ("The loop is at build, not verify"), silently
// dropping a real verdict. The guard turns that late, confusing rejection into
// an early, actionable error.

test("matching stage passes", () => {
  assert.equal(stageOrderError("build", "build"), null)
  assert.equal(stageOrderError("verify", "verify"), null)
})

test("out-of-order stage is rejected with both stage names and the missing call", () => {
  const msg = stageOrderError("build", "verify")
  assert.ok(msg, "expected an error message")
  assert.match(msg, /"verify"/)
  assert.match(msg, /"build"/)
  assert.match(msg, /loop_advance/)
})

test("stage behind the machine is rejected too", () => {
  const msg = stageOrderError("review", "verify")
  assert.ok(msg, "expected an error message")
  assert.match(msg, /"verify"/)
  assert.match(msg, /"review"/)
})
