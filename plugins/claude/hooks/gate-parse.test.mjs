import assert from "node:assert/strict"
import { test } from "node:test"
import { gateArgsFor, verbFor } from "./gate-parse.mjs"

/**
 * The gate hook's prompt classifier. Gate verbs of /agentic-workflow:engineering
 * must yield the exact CLI argv; everything else — authoring verbs, execution
 * verbs, ordinary prose (especially prose containing the plain word
 * "engineering") — must return null so the model's turn runs untouched.
 */

test("approve with an id routes to approve-any (namespaced and bare command forms)", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"] })
  assert.deepEqual(gateArgsFor("/engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"] })
})

test("bare approve routes to approve-any with no id (auto-resolve)", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve"), { argv: ["gate", "approve-any"] })
})

test("replan carries the optional id and reason words through", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering replan my-task the plan misses the cache layer"), {
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
    "/agentic-workflow:engineering new add rate limiting",
    "/agentic-workflow:engineering plan my-task",
    "/agentic-workflow:engineering claim",
    "/agentic-workflow:engineering status",
    "/agentic-workflow:pr-sitter claim",
    "how do I approve a plan?",
    "approve my-task", // bare word — not namespaced under the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("retask dispatches with continueTurn — the move is deterministic, the reshape is not", () => {
  const d = gateArgsFor("/agentic-workflow:engineering retask my-task tighten acceptance")
  assert.deepEqual(d.argv, ["gate", "retask", "my-task"])
  assert.equal(d.continueTurn, true, "the model must still run the interview")
})

test("a bare retask is malformed — passed through so the model reports usage", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering retask"), { passThrough: true })
})

test("remove routes to the gate remove CLI verb and blocks the turn", () => {
  const d = gateArgsFor("/agentic-workflow:engineering remove my-task")
  assert.deepEqual(d.argv, ["gate", "remove", "my-task"])
  assert.ok(!d.continueTurn, "the CLI does the whole delete — nothing left for the model")
})

test("a bare remove is malformed — never guess which task to delete", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove"), { passThrough: true })
})

test("remove forwards --force, and forwards nothing when the user didn't type it", () => {
  // The hook dispatches and then BLOCKS, so no model turn exists in which to
  // confirm — the flag has to survive parsing or the confirmation is unreachable.
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove my-task --force").argv, ["gate", "remove", "my-task", "--force"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove -f my-task").argv, ["gate", "remove", "my-task", "--force"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove my-task").argv, ["gate", "remove", "my-task"])
})

test("a flag never becomes the id — `remove --force` names no task, so it is malformed", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove --force"), { passThrough: true })
})

test("abandon routes to the gate abandon CLI verb, carrying its reason", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon my-task").argv, ["gate", "abandon", "my-task"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon my-task superseded by the epic").argv, [
    "gate",
    "abandon",
    "my-task",
    "superseded",
    "by",
    "the",
    "epic",
  ])
})

test("a bare abandon is malformed — never guess which task to cancel", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon"), { passThrough: true })
})

test("prose containing the plain word 'engineering' never fires a gate", () => {
  for (const prompt of [
    "the engineering approve step happens at the plan gate",
    "our engineering approve process is strict",
    "in engineering replan means re-planning",
    "agentic-workflow:engineering approve my-task", // no leading slash — prose quoting the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("removed verbs no longer match — ok/go/reject/ship/approve-plan are not gates", () => {
  for (const prompt of [
    "/agentic-workflow:engineering ok my-task",
    "/agentic-workflow:engineering go",
    "/agentic-workflow:engineering reject my-task why",
    "/agentic-workflow:engineering ship my-task",
    "/agentic-workflow:engineering approve-plan my-task",
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("verbs are matched as whole words — approver doesn't trigger a gate", () => {
  assert.equal(gateArgsFor("/agentic-workflow:engineering approver thing"), null)
})

/**
 * `verbFor` drives the per-verb instruction injection (verb-slice.mjs), not a
 * gate move, so it must recognise EVERY verb — including the ones gateArgsFor
 * ignores. It shares the command regex, so the leading-slash rule that keeps
 * the ordinary word "engineering" from matching applies here too.
 */

test("verbFor reads the verb from the first token, both command forms", () => {
  assert.equal(verbFor("/agentic-workflow:engineering new add rate limiting"), "new")
  assert.equal(verbFor("/engineering claim"), "claim")
  assert.equal(verbFor("/agentic-workflow:engineering doctor fix"), "doctor")
})

test("verbFor never mistakes a verb-like word in the payload for the verb", () => {
  // The exact confusion the command body warns about.
  assert.equal(verbFor("/agentic-workflow:engineering new add a status dashboard"), "new")
  assert.equal(verbFor("/agentic-workflow:engineering retask f7k3 approve it later"), "retask")
})

test("verbFor treats a bare command as status, which is what it runs", () => {
  assert.equal(verbFor("/agentic-workflow:engineering"), "status")
  assert.equal(verbFor("/agentic-workflow:engineering   "), "status")
})

test("verbFor lowercases the verb, so markup lookup is case-insensitive", () => {
  assert.equal(verbFor("/agentic-workflow:engineering NEW an idea"), "new")
})

test("verbFor ignores prose and other kinds' commands", () => {
  // This hook has matcher "" and sees every prompt in the session.
  assert.equal(verbFor("the engineering approve step happens later"), null)
  assert.equal(verbFor("/agentic-workflow:pr-sitter claim"), null)
  assert.equal(verbFor("please review my PR"), null)
  assert.equal(verbFor(""), null)
  assert.equal(verbFor(undefined), null)
})
