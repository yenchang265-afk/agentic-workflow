import assert from "node:assert/strict"
import { test } from "node:test"
import { ASK_GATES, gateAsk, planParkAsk } from "./gate-ask.mjs"
import { dialectFor } from "./src/dialect.mjs"

/**
 * The gate follow-up the hook injects after a deterministic gate move. It is the
 * BOUND half of the "plan it now?" question: the verb prose can describe the ask,
 * but prose is what the orchestrator already does not reliably follow, so the
 * imperative is emitted by the harness with the id and the tool name filled in.
 */

test("the task gate asks whether to plan now, naming the task and the host's tool", () => {
  const ask = gateAsk("task", "f7k3-rate-limit", dialectFor("claude").askTool)
  assert.ok(ask)
  assert.match(ask, /f7k3-rate-limit/)
  assert.match(ask, /AskUserQuestion/)
  assert.match(ask, /Plan/)
  // The Yes branch must carry the PLAN procedure itself: a follow-up that only
  // says "plan it" leaves the model to guess between workflow_start and a raw
  // subagent spawn.
  assert.match(ask, /workflow_start/)
  assert.match(ask, /workflow-plan-author/)
  assert.match(ask, /workflow_advance/)
})

// The whole point of the injected block is that it outranks the verb prose it is
// appended to — the approve block still describes a turn that normally never runs.
test("the follow-up declares itself authoritative over the verb prose", () => {
  const ask = gateAsk("task", "t", "AskUserQuestion")
  assert.match(ask, /GATE FOLLOW-UP/)
  assert.match(ask, /already/i, "it must say the move already happened, or the model re-runs it")
})

test("a Qwen follow-up names Qwen's tool and never Claude's", () => {
  const ask = gateAsk("task", "t", dialectFor("qwen").askTool)
  assert.match(ask, /ask_user_question/)
  assert.doesNotMatch(ask, /AskUserQuestion/)
})

/**
 * Ship is terminal — there is nothing to ask — and an unrecognized gate is what a
 * stale mcp-server/dist produces. Both must return null so the hook keeps blocking
 * the turn, which is exactly today's behaviour. Fail-safe by construction: the
 * continue path only exists where this function speaks.
 */
test("only the gates listed in ASK_GATES produce a follow-up", () => {
  assert.deepEqual(ASK_GATES, ["task"])
  assert.equal(gateAsk("ship", "t", "AskUserQuestion"), null)
  assert.equal(gateAsk("plan", "t", "AskUserQuestion"), null)
  assert.equal(gateAsk("nonsense", "t", "AskUserQuestion"), null)
  assert.equal(gateAsk(undefined, "t", "AskUserQuestion"), null)
})

// The id is interpolated into the block, so a missing one would emit an
// instruction naming `undefined` — worse than staying silent and blocking.
test("a follow-up without a usable id or tool is refused", () => {
  assert.equal(gateAsk("task", "", "AskUserQuestion"), null)
  assert.equal(gateAsk("task", undefined, "AskUserQuestion"), null)
  assert.equal(gateAsk("task", "t", ""), null)
})

/**
 * The plan-park follow-up (plan-gate-ask.mjs). Same contract as the task gate's,
 * one trigger later: the loop has ENDED and the human owns the next move, so the
 * block has to name the tool behind every option AND stop the model driving on.
 */
test("a parked plan asks for approval, naming the task and every option's tool", () => {
  const ask = planParkAsk("f7k3-rate-limit", dialectFor("claude").askTool)
  assert.ok(ask)
  assert.match(ask, /f7k3-rate-limit/)
  assert.match(ask, /AskUserQuestion/)
  assert.match(ask, /workflow_plan_approve/, "Approve must name the tool that crosses the gate")
  assert.match(ask, /workflow_replan/, "Replan without a tool is theatre — the model could only suggest a command")
  assert.match(ask, /plan-review/)
  assert.match(ask, /already/i, "it must say the park already happened, or the model re-runs the stage")
})

test("a Qwen plan-park follow-up names Qwen's tool and never Claude's", () => {
  const ask = planParkAsk("t", dialectFor("qwen").askTool)
  assert.match(ask, /ask_user_question/)
  assert.doesNotMatch(ask, /AskUserQuestion/)
})

test("a plan-park follow-up without a usable id or tool is refused", () => {
  assert.equal(planParkAsk("", "AskUserQuestion"), null)
  assert.equal(planParkAsk(undefined, "AskUserQuestion"), null)
  assert.equal(planParkAsk("t", ""), null)
  assert.equal(planParkAsk("t", undefined), null)
})
