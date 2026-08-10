import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { planGateOf } from "./plan-gate-ask.mjs"

/**
 * The PLAN GATE follow-up: after `workflow_advance` parks a plan, the harness
 * repeats the ask as a system reminder rather than leaving it as a `next` string
 * inside the tool result — prose in data is what the orchestrator skips.
 *
 * Two properties are worth pinning, and they pull in opposite directions:
 * the reminder must reach the model on a real park (naming the id and the HOST's
 * question tool), and it must never appear on anything else — every unknown
 * envelope shape, every other gate, every unparseable payload exits silently.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "plan-gate-ask.mjs")

const run = (payload, env = {}) => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  assert.equal(res.status, 0, `the hook must never fail the tool call: ${res.stderr}`)
  return res.stdout ? JSON.parse(res.stdout) : null
}

/** The shape mcp-server's `ok()` writes: one text part holding the JSON. */
const parkResult = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] })

const PARK = {
  action: { kind: "park", message: "Plan written." },
  path: "docs/tasks/plan-review/f7k3-rate-limit.md",
  gate: { kind: "plan", id: "f7k3-rate-limit" },
  next: "plan gate: show the user the plan summary, then ask with AskUserQuestion — …",
}

const injected = (out) => out?.hookSpecificOutput?.additionalContext ?? ""

test("a parked plan injects the ask, naming the task and the host's question tool", () => {
  const out = run({ hook_event_name: "PostToolUse", tool_name: "mcp__agentic-workflow__workflow_advance", tool_response: parkResult(PARK) })
  assert.equal(out?.hookSpecificOutput?.hookEventName, "PostToolUse")
  assert.match(injected(out), /f7k3-rate-limit/)
  assert.match(injected(out), /AskUserQuestion/)
  // Every option must name the tool that executes it — an ask whose answer the
  // model cannot act on is worse than no ask.
  assert.match(injected(out), /workflow_plan_approve/)
  assert.match(injected(out), /workflow_replan/)
  // And it must stop the model from driving the loop onward on its own.
  assert.match(injected(out), /workflow_advance/)
})

test("a Qwen park names Qwen's question tool and never Claude's", () => {
  const out = run(
    { tool_name: "workflow_advance", tool_response: parkResult(PARK) },
    { AGENTIC_WORKFLOW_HOST: "qwen" },
  )
  assert.match(injected(out), /ask_user_question/)
  assert.doesNotMatch(injected(out), /AskUserQuestion/)
})

/**
 * The envelope is not one fixed shape across host versions, and the field name
 * has already varied once for the prompt (gate-command.mjs). Both known value
 * shapes must work; anything else must fail open rather than guess.
 */
test("the known envelope spellings all reach the ask", () => {
  const body = JSON.stringify(PARK)
  assert.match(injected(run({ tool_response: [{ type: "text", text: body }] })), /f7k3-rate-limit/, "bare content array")
  assert.match(injected(run({ tool_response: body })), /f7k3-rate-limit/, "already-extracted text")
  assert.match(injected(run({ toolResponse: parkResult(PARK) })), /f7k3-rate-limit/, "camelCase field")
  assert.match(injected(run({ tool_response: PARK })), /f7k3-rate-limit/, "structured payload")
})

test("only a plan gate asks — every other result is silent", () => {
  assert.equal(run({ tool_response: parkResult({ gate: { kind: "ship", id: "f7k3" } }) }), null)
  assert.equal(run({ tool_response: parkResult({ gate: { kind: "task", id: "f7k3" } }) }), null)
  // The fire arm of workflow_advance: a stage payload, no gate at all.
  assert.equal(run({ tool_response: parkResult({ action: { kind: "fire", stage: "build" }, agent: "workflow-build" }) }), null)
})

/**
 * Fail-open is the whole safety argument: a false silence costs the reminder,
 * a false reminder tells the model to gate a task that never parked. An
 * mcp-server/dist predating the gate descriptor lands in the last case here.
 */
test("an unusable payload is silent, never an error", () => {
  assert.equal(run("not json at all"), null)
  assert.equal(run({}), null, "no tool_response field")
  assert.equal(run({ tool_response: parkResult(PARK).content[0] }), null, "a lone part, not the content array")
  assert.equal(run({ tool_response: { content: [{ type: "text", text: "Plan written for f7k3." }] } }), null, "plain-text result")
  assert.equal(run({ tool_response: parkResult({ gate: { kind: "plan" } }) }), null, "a gate with no id")
  assert.equal(run({ tool_response: parkResult({ action: { kind: "park" }, next: "ask with AskUserQuestion" }) }), null, "next without a gate")
})

// The parsing half is pure, so pin it directly too — the hook's own arms above
// cannot distinguish "found nothing" from "found something and refused to write".
test("planGateOf reads the id out of every accepted shape and nothing else", () => {
  assert.equal(planGateOf(parkResult(PARK)), "f7k3-rate-limit")
  assert.equal(planGateOf(PARK), "f7k3-rate-limit")
  assert.equal(planGateOf(JSON.stringify(PARK)), "f7k3-rate-limit")
  assert.equal(planGateOf(undefined), null)
  assert.equal(planGateOf({ gate: { kind: "plan", id: 7 } }), null)
})
