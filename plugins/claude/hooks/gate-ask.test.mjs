import assert from "node:assert/strict"
import { test } from "node:test"
import { ASK_AMBIGUITY_VERBS, ASK_GATES, gateAmbiguityAsk, gateAsk, planParkAsk } from "./gate-ask.mjs"
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

// --- The slice walk, on the task gate's follow-up ---

const SLICES = [
  { id: "c3d4-ui", from: "draft", title: "Wire the UI", priority: 1, epic: "k2p9-epic" },
  { id: "e5f6-docs", from: "draft", title: "Document it", priority: 2, epic: "k2p9-epic" },
]

/**
 * A slice set is walked one child at a time, and the plugin — not the prose —
 * has to name the next one: nothing else in the turn knows what is left.
 */
test("a task gate on a slice names the next one to offer, on the NOT-YET branch", () => {
  const ask = gateAsk("task", "a1b2-api", "AskUserQuestion", { siblings: SLICES })
  assert.match(ask, /CONTINUE THE SLICE WALK/)
  assert.match(ask, /Approve `c3d4-ui` now\?/, "the NEXT slice by priority, named outright")
  assert.match(ask, /Wire the UI/, "with its title — an id alone is not answerable")
  assert.match(ask, /workflow_approve\(\{id: "c3d4-ui"\}\)/)
  assert.match(ask, /2 slices/)
})

/**
 * The yes branch must NOT walk. On OpenCode `workflow_plan` hands the session to
 * a PLAN drive at concurrency 1, after which there is no free model turn to ask
 * anything in — so the remaining slices are reported there, never offered.
 */
test("the plan branch reports the remaining slices but does not offer them", () => {
  const ask = gateAsk("task", "a1b2-api", "AskUserQuestion", { siblings: SLICES })
  const planArm = ask.slice(ask.indexOf("2. **Yes**"), ask.indexOf("3. **Not yet**"))
  assert.match(planArm, /walk STOPS/)
  assert.match(planArm, /still un-approved/)
  assert.doesNotMatch(planArm, /workflow_approve/, "the plan arm must not approve a sibling")
})

test("the closing line still forbids everything except the named next slice", () => {
  const ask = gateAsk("task", "a1b2-api", "AskUserQuestion", { siblings: SLICES })
  assert.match(ask, /Build no task in this turn/)
  assert.match(ask, /ONLY other task you may approve is\s+the next slice/)
})

/**
 * The downgrade path, and the one that matters most: a standalone task, a
 * hand-written draft, and a core dist too old to report `siblings` must all
 * render the block exactly as it read before slice sets existed.
 */
test("with no usable siblings the follow-up is byte-identical to the standalone one", () => {
  const base = gateAsk("task", "t", "AskUserQuestion")
  for (const data of [undefined, {}, { siblings: [] }, { siblings: "nope" }, { siblings: [{ id: "x" }] }]) {
    assert.equal(gateAsk("task", "t", "AskUserQuestion", data), base, `siblings=${JSON.stringify(data)}`)
  }
  assert.match(base, /Plan, approve or build no OTHER task in this turn\./)
  assert.doesNotMatch(base, /SLICE WALK/)
})

// --- The pick-one ask for an ambiguous id-less approve ---

const CANDIDATES = [
  { id: "a1b2-api", from: "draft", title: "Add the API layer", priority: 0, epic: "k2p9-epic" },
  { id: "c3d4-ui", from: "draft", title: "Wire the UI", priority: 1, epic: "k2p9-epic" },
]

/**
 * The dead end this replaces: a bare `approve` over a slice set refused with
 * "pass an id" and BLOCKED the turn, so the model could not even ask which one.
 * Continuing here is sound only because nothing moved — and the block has to say
 * so, or the model reports a move that never happened.
 */
test("the ambiguity ask offers every candidate and insists nothing moved", () => {
  const ask = gateAmbiguityAsk(CANDIDATES, "AskUserQuestion")
  assert.match(ask, /GATE AMBIGUITY/)
  assert.match(ask, /NOTHING HAS MOVED/)
  assert.match(ask, /never guesses/)
  for (const c of CANDIDATES) {
    assert.match(ask, new RegExp(`\`${c.id}\` — ${c.title} \\(draft, slice of epic \`k2p9-epic\`\\)`))
  }
  assert.match(ask, /None — leave them all/)
  assert.match(ask, /move no OTHER task in this turn/)
})

test("a candidate outside a slice set renders without an epic clause", () => {
  const ask = gateAmbiguityAsk(
    [
      { id: "a1b2", from: "plan-review", title: "A parked plan", priority: 0 },
      { id: "c3d4", from: "in-review", title: "A finished branch", priority: 0 },
    ],
    "AskUserQuestion",
  )
  assert.match(ask, /`a1b2` — A parked plan \(plan-review\)/)
  assert.doesNotMatch(ask, /slice of epic/)
})

test("a Qwen ambiguity ask names Qwen's tool and never Claude's", () => {
  const ask = gateAmbiguityAsk(CANDIDATES, dialectFor("qwen").askTool)
  assert.match(ask, /ask_user_question/)
  assert.doesNotMatch(ask, /AskUserQuestion/)
})

test("a plan-park follow-up without a usable id or tool is refused", () => {
  assert.equal(planParkAsk("", "AskUserQuestion"), null)
  assert.equal(planParkAsk(undefined, "AskUserQuestion"), null)
  assert.equal(planParkAsk("t", ""), null)
  assert.equal(planParkAsk("t", undefined), null)
})

/**
 * Fail-safe, like `gateAsk`: every uncertainty returns null and the caller falls
 * back to blocking with core's own message. One malformed entry discards the
 * WHOLE list rather than being filtered out — a partial list could silently omit
 * the very task the human meant, while the plain refusal costs them one typed id.
 */
test("an unusable candidate list is refused rather than partly rendered", () => {
  assert.equal(gateAmbiguityAsk([CANDIDATES[0]], "AskUserQuestion"), null, "one candidate is not an ambiguity")
  assert.equal(gateAmbiguityAsk([], "AskUserQuestion"), null)
  assert.equal(gateAmbiguityAsk(undefined, "AskUserQuestion"), null)
  assert.equal(gateAmbiguityAsk("not-a-list", "AskUserQuestion"), null)
  assert.equal(gateAmbiguityAsk([CANDIDATES[0], { id: "c3d4-ui", from: "draft" }], "AskUserQuestion"), null, "a title-less entry discards the list")
  assert.equal(gateAmbiguityAsk([CANDIDATES[0], null], "AskUserQuestion"), null)
  assert.equal(gateAmbiguityAsk(CANDIDATES, ""), null, "a host with no question tool cannot ask")
})

// Only `approve` resolves without an id; a `replan` also needs a typed reason,
// so a pick-one there would collect half an answer.
test("only approve-any may continue on an ambiguity", () => {
  assert.deepEqual(ASK_AMBIGUITY_VERBS, ["approve-any"])
})
