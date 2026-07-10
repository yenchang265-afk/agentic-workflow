import assert from "node:assert/strict"
import { test } from "node:test"
import { gateArgsFor } from "./gate-parse.mjs"

/**
 * The gate hook's prompt classifier. Gate verbs must yield the exact CLI argv;
 * everything else — authoring verbs, execution verbs, ordinary prose — must
 * return null so the model's turn runs untouched.
 */

test("approve with an id routes to approve-any with the id", () => {
  assert.deepEqual(gateArgsFor("/agent-loop approve my-task"), { argv: ["gate", "approve-any", "my-task"] })
})

test("bare approve routes to approve-any with no id (auto-resolve)", () => {
  assert.deepEqual(gateArgsFor("/agent-loop approve"), { argv: ["gate", "approve-any"] })
})

test("ok and go are approve aliases", () => {
  assert.deepEqual(gateArgsFor("/agent-loop ok my-task"), { argv: ["gate", "approve-any", "my-task"] })
  assert.deepEqual(gateArgsFor("/agent-loop go"), { argv: ["gate", "approve-any"] })
})

test("approve-plan requires and captures its id — approve never swallows the -plan suffix", () => {
  assert.deepEqual(gateArgsFor("/agent-loop approve-plan my-task"), { argv: ["gate", "approve-plan", "my-task"] })
  assert.deepEqual(gateArgsFor("/agent-loop approve-plan"), { passThrough: true })
})

test("reject carries the optional id and reason words through", () => {
  assert.deepEqual(gateArgsFor("/agent-loop reject my-task the plan misses the cache layer"), {
    argv: ["gate", "reject-any", "my-task", "the", "plan", "misses", "the", "cache", "layer"],
  })
  assert.deepEqual(gateArgsFor("/agent-loop reject"), { argv: ["gate", "reject-any"] })
})

test("redo and replan are reject aliases", () => {
  assert.deepEqual(gateArgsFor("/agent-loop redo my-task"), { argv: ["gate", "reject-any", "my-task"] })
  assert.deepEqual(gateArgsFor("/agent-loop replan my-task too vague"), {
    argv: ["gate", "reject-any", "my-task", "too", "vague"],
  })
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
    "/agent-loop new add rate limiting",
    "/agent-loop retask my-task tighten acceptance",
    "/agent-loop task my-task",
    "/agent-loop claim pr-sitter",
    "/agent-loop status",
    "/agent-loop my-task",
    "how do I approve a plan?",
    "approve my-task", // bare word — not namespaced under /agent-loop
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("verbs are matched as whole words — approver/going don't trigger gates", () => {
  assert.equal(gateArgsFor("/agent-loop approver thing"), null)
  assert.equal(gateArgsFor("/agent-loop going somewhere"), null)
})
