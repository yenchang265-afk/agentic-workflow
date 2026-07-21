import assert from "node:assert/strict"
import { test } from "node:test"
import { gateArgsFor } from "./gate-parse.mjs"

/**
 * The gate hook's prompt classifier. Gate verbs of /agentic-loop:engineering
 * must yield the exact CLI argv; everything else — authoring verbs, execution
 * verbs, ordinary prose (especially prose containing the plain word
 * "engineering") — must return null so the model's turn runs untouched.
 */

test("approve with an id routes to approve-any (namespaced and bare command forms)", () => {
  assert.deepEqual(gateArgsFor("/agentic-loop:engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"] })
  assert.deepEqual(gateArgsFor("/engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"] })
})

test("bare approve routes to approve-any with no id (auto-resolve)", () => {
  assert.deepEqual(gateArgsFor("/agentic-loop:engineering approve"), { argv: ["gate", "approve-any"] })
})

test("replan carries the optional id and reason words through", () => {
  assert.deepEqual(gateArgsFor("/agentic-loop:engineering replan my-task the plan misses the cache layer"), {
    argv: ["gate", "reject-any", "my-task", "the", "plan", "misses", "the", "cache", "layer"],
  })
  assert.deepEqual(gateArgsFor("/engineering replan"), { argv: ["gate", "reject-any"] })
})

test("the GATE-DISPATCH sentinel routes its verb and requires an id", () => {
  assert.deepEqual(gateArgsFor("GATE-DISPATCH: approve-plan my-task"), { argv: ["gate", "approve-plan", "my-task"] })
  assert.deepEqual(gateArgsFor("GATE-DISPATCH: replan my-task reason here"), {
    argv: ["gate", "replan", "my-task", "reason here"],
  })
  assert.deepEqual(gateArgsFor("GATE-DISPATCH: approve"), { passThrough: true })
})

test("non-gate verbs and prose pass through as null", () => {
  for (const prompt of [
    "/agentic-loop:engineering new add rate limiting",
    "/agentic-loop:engineering plan my-task",
    "/agentic-loop:engineering claim",
    "/agentic-loop:engineering status",
    "/agentic-loop:pr-sitter claim",
    "how do I approve a plan?",
    "approve my-task", // bare word — not namespaced under the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("retask dispatches with continueTurn — the move is deterministic, the reshape is not", () => {
  const d = gateArgsFor("/agentic-loop:engineering retask my-task tighten acceptance")
  assert.deepEqual(d.argv, ["gate", "retask", "my-task"])
  assert.equal(d.continueTurn, true, "the model must still run the interview")
})

test("a bare retask is malformed — passed through so the model reports usage", () => {
  assert.deepEqual(gateArgsFor("/agentic-loop:engineering retask"), { passThrough: true })
})

test("prose containing the plain word 'engineering' never fires a gate", () => {
  for (const prompt of [
    "the engineering approve step happens at the plan gate",
    "our engineering approve process is strict",
    "in engineering replan means re-planning",
    "agentic-loop:engineering approve my-task", // no leading slash — prose quoting the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("removed verbs no longer match — ok/go/reject/ship/approve-plan are not gates", () => {
  for (const prompt of [
    "/agentic-loop:engineering ok my-task",
    "/agentic-loop:engineering go",
    "/agentic-loop:engineering reject my-task why",
    "/agentic-loop:engineering ship my-task",
    "/agentic-loop:engineering approve-plan my-task",
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("verbs are matched as whole words — approver doesn't trigger a gate", () => {
  assert.equal(gateArgsFor("/agentic-loop:engineering approver thing"), null)
})
