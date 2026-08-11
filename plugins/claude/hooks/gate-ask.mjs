/**
 * The gate follow-ups the harness injects, and the ONE place their text lives.
 *
 * Two triggers, two writers, one rule: the imperative is emitted by the harness
 * with the id and the host's tool name already substituted.
 *
 * - `gateAsk` — after a gate VERB's deterministic move (gate-command.mjs).
 * - `planParkAsk` — after the PLAN stage PARKS a plan (plan-gate-ask.mjs).
 *
 * `/agentic-workflow:engineering approve` is handled by the harness before the
 * model runs (gate-command.mjs), and it used to block the turn outright. That is
 * right for a move nothing follows — but the task gate is the one gate with an
 * obvious next question ("plan it now?"), and a blocked turn can never ask it. So
 * a task-gate success now hands the turn back with this block appended.
 *
 * Why the imperative lives HERE and not only in the verb prose: the orchestrator
 * is precisely the thing that already does not reliably follow prose (the same
 * reason `stageModels` is bound by a hook rather than asked for). The verb block
 * describes the ask; this string, emitted by the harness with the id and the
 * host's tool name already substituted, is what actually carries it.
 *
 * Fail-safe by construction: every uncertainty returns null, and the caller
 * blocks the turn when it does — i.e. it degrades to exactly the old behaviour.
 * A stale `mcp-server/dist` that predates `data.gate` reaches none of this.
 *
 * Pure and dependency-free, like gate-parse.mjs / gate-result.mjs, so it unit
 * tests under bare `node --test`.
 */

/**
 * The gates worth a follow-up question AFTER A GATE VERB — the list
 * gate-parse.mjs reads as `continueOnGate`, i.e. which crossings hand the turn
 * back instead of blocking it.
 *
 * `ship` is terminal — nothing follows a completed task. `plan` is deliberately
 * absent: the question after a plan gate is "build it now?", and building on one
 * word is a much bigger commitment than planning on one. `workflow-orchestration`
 * requires a separate explicit answer before a build, so that arm stays with the
 * interactive flow that can honour it.
 *
 * Never add "plan" here to reach `planParkAsk` below. That ask fires on the PLAN
 * stage's PARK, which is not a gate verb and never passes through gate-command.mjs
 * at all; adding it here would instead change what `approve` does when it crosses
 * the plan gate — a different move, with a documented reason to keep blocking.
 */
export const ASK_GATES = ["task"]

/**
 * The gate CLI verbs whose id-less AMBIGUITY may hand the turn back for a
 * pick-one ask, in the same one-source-of-truth arrangement as `ASK_GATES`: this
 * file declares the policy, gate-parse.mjs imports it, and the CLI's `data`
 * supplies the evidence.
 *
 * Only `approve-any` is here — it is the one verb that resolves without an id,
 * and a slice set is what dead-ends it. `reject-any` resolves id-lessly too but
 * needs a REASON the human types, so a pick-one there would collect half an
 * answer.
 */
export const ASK_AMBIGUITY_VERBS = ["approve-any"]

/** Ids the follow-up may name inline before it stops enumerating and defers to the message. */
const MAX_LISTED = 6

/** ``[`a`, `b`]`` — ids in backticks, comma-joined. */
const idList = (candidates) => candidates.map((c) => `\`${c.id}\``).join(", ")

/** "1 slice" / "2 slices" — these strings land in a human-read transcript too. */
const sliceCount = (n) => `${n} ${n === 1 ? "slice" : "slices"}`

/**
 * One candidate as an option line: the id, its title (what actually makes the
 * choice answerable), its folder, and its slice-set membership when it has one.
 */
const optionLine = (c) => `   - \`${c.id}\` — ${c.title} (${c.from}${c.epic ? `, slice of epic \`${c.epic}\`` : ""})`

/**
 * The tail that keeps a slice-set walk going after a child is queued, or "" when
 * this task is not part of one. Only the "not yet" arm gets it: the plan arm
 * hands the session to a PLAN drive on OpenCode, after which nothing can ask the
 * human anything until it unwinds.
 */
const walkTail = (siblings, askTool) => {
  if (!siblings.length) return ""
  const next = siblings[0]
  return ` Then CONTINUE THE SLICE WALK — this set has ${sliceCount(siblings.length)} left
   un-approved (${idList(siblings)}). Ask ONE more ${askTool}: "Approve \`${next.id}\` now?" (${next.title}),
   options "Approve" and "Not yet". On approve, call workflow_approve({id: "${next.id}"}) and
   follow the follow-up it returns. On "not yet", stop — \`/agentic-workflow:engineering
   approve\` offers the rest later.`
}

const taskGateAsk = (id, askTool, siblings) =>
  `GATE FOLLOW-UP — emitted by the agentic-workflow plugin, not by the model. Where this
disagrees with any description of \`approve\` above, this wins.

The task gate has ALREADY fired for \`${id}\`: the file is in docs/tasks/queued/ and the
move is committed. Do not call workflow_approve, workflow_task_approve, or any other
gate tool for it — that work is done. Do exactly this, and nothing else:

1. Ask the user with ${askTool} — header "Plan now", question "Plan \`${id}\` now?",
   options "Yes — plan it now" and "Not yet". One question, this turn.
2. **Yes** → run the PLAN pass for \`${id}\` now: \`workflow_start({id: "${id}"})\`, spawn
   \`workflow-plan-author\` with the prompt it returns, then \`workflow_advance\`. The plan
   parks in plan-review/ and the PLAN GATE goes live — ask again with ${askTool}:
   Approve / Replan (with the user's reason) / Park for later.${
     siblings.length
       ? `
   The walk STOPS there for this turn — planning owns the rest of it. Tell the user that
   ${sliceCount(siblings.length)} of this set ${siblings.length === 1 ? "is" : "are"} still un-approved
   (${idList(siblings)}) and that a later \`/agentic-workflow:engineering approve\` offers them.`
       : ""
   }
3. **Not yet** → report that the task is queued.${siblings.length ? walkTail(siblings, askTool) : " Stop there."}

${
  siblings.length
    ? `Build no task in this turn, and plan only \`${id}\`. The ONLY other task you may approve is
the next slice named in step 3 — nothing else.`
    : "Plan, approve or build no OTHER task in this turn."
}`

const ambiguityAsk = (candidates, askTool) => {
  const listed = candidates.slice(0, MAX_LISTED)
  const rest = candidates.slice(MAX_LISTED)
  return `GATE AMBIGUITY — emitted by the agentic-workflow plugin, not by the model. Where this
disagrees with any description of \`approve\` above, this wins.

NOTHING HAS MOVED. A bare \`approve\` found ${candidates.length} tasks waiting, and this plugin
never guesses which one the human meant: approving is their decision, and a stacked slice
must NOT be approved ahead of its turn. Do exactly this, and nothing else:

1. Ask the user with ${askTool} — header "Approve which", question "Which task should
   \`approve\` advance?", one option per candidate, in this order:
${listed.map(optionLine).join("\n")}${rest.length ? `\n   …and name the remaining ${rest.length} in the question text so they can be picked by id: ${idList(rest)}.` : ""}
   Add a final option "None — leave them all".
2. On a pick → call workflow_approve with that exact id (\`{id: "<what they picked>"}\`), then
   follow the \`next\` field of whatever it returns.
3. On "None" → report that nothing moved, and stop.

Approve nothing the user did not just pick, and move no OTHER task in this turn.`
}

/**
 * The candidate list to render, or [] when anything about it is off — a
 * non-array, fewer than two entries (not an ambiguity at all), or an entry
 * missing a field the prose interpolates.
 *
 * One malformed entry discards the WHOLE list rather than being filtered out: a
 * partial pick-one would silently hide the very task the human meant, while
 * falling back to the plain refusal costs them one typed id.
 */
const usableCandidates = (value, min) => {
  if (!Array.isArray(value) || value.length < min) return []
  const shaped = (c) =>
    !!c && typeof c === "object" && typeof c.id === "string" && !!c.id && typeof c.title === "string" && typeof c.from === "string" && !!c.from
  return value.every(shaped) ? value : []
}

/**
 * The follow-up for a gate move, or null when there is nothing to ask — an
 * unrecognized/terminal gate, a missing task id, or a host with no question tool.
 * `id` is interpolated into the block, so a missing one must return null rather
 * than emit an instruction naming `undefined`.
 *
 * `data` is the whole `GateResult.data`; the slice-set walk reads `siblings` off
 * it. An absent or unusable list yields exactly the pre-slice-set block, so a
 * standalone task, a hand-written draft and an older core dist all render the
 * string this file has always emitted.
 */
export const gateAsk = (gate, id, askTool, data) => {
  if (!ASK_GATES.includes(gate)) return null
  if (typeof id !== "string" || !id) return null
  if (typeof askTool !== "string" || !askTool) return null
  // min 1: one remaining slice is a walk worth continuing, unlike an ambiguity,
  // which needs two things to choose between.
  return taskGateAsk(id, askTool, usableCandidates(data?.siblings, 1))
}

/**
 * The pick-one follow-up for an id-less gate verb that found several candidates,
 * or null when there is nothing askable — an unusable list, or a host with no
 * question tool.
 *
 * Fail-safe like `gateAsk`: null means the caller blocks the turn with the
 * plain "Multiple tasks awaiting" refusal, i.e. exactly the old behaviour.
 */
export const gateAmbiguityAsk = (candidates, askTool) => {
  if (typeof askTool !== "string" || !askTool) return null
  const list = usableCandidates(candidates, 2)
  return list.length ? ambiguityAsk(list, askTool) : null
}

const planParkBlock = (id, askTool) =>
  `PLAN GATE — emitted by the agentic-workflow plugin, not by the model. Where this
disagrees with the tool result above, this wins.

The PLAN stage has ALREADY parked the plan for \`${id}\`: the file is in
docs/tasks/plan-review/ and the loop has ENDED. Do not call workflow_advance,
workflow_stage or workflow_start for it — the plan gate is the human's to cross, not
yours. Do exactly this, and nothing else:

1. Summarize the parked plan for the user in a few lines — they are about to approve it.
2. Ask the user with ${askTool} — header "Plan gate", question "Approve the plan for
   \`${id}\`?", options "Approve — build it", "Replan (give a reason)" and "Not now".
   One question, this turn.
3. **Approve** → \`workflow_plan_approve({id: "${id}"})\`, then follow that result's own
   \`next\` line (it carries the build question).
4. **Replan** → ask for the reason if the user did not give one, then
   \`workflow_replan({id: "${id}", reason})\`.
5. **Not now** → report that the plan waits in plan-review/, and stop.

Approve, replan or build no OTHER task in this turn.`

/**
 * The follow-up for a parked plan, or null when there is nothing to ask.
 *
 * Same fail-safe construction as `gateAsk`: every uncertainty returns null and the
 * hook then emits nothing, degrading to the `next` line the MCP result already
 * carries — which is exactly today's behaviour.
 */
export const planParkAsk = (id, askTool) => {
  if (typeof id !== "string" || !id) return null
  if (typeof askTool !== "string" || !askTool) return null
  return planParkBlock(id, askTool)
}
