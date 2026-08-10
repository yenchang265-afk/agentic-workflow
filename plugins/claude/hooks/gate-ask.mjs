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

const taskGateAsk = (id, askTool) =>
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
   Approve / Replan (with the user's reason) / Park for later.
3. **Not yet** → report that the task is queued, and stop.

Plan, approve or build no OTHER task in this turn.`

/**
 * The follow-up for a gate move, or null when there is nothing to ask — an
 * unrecognized/terminal gate, a missing task id, or a host with no question tool.
 * `id` is interpolated into the block, so a missing one must return null rather
 * than emit an instruction naming `undefined`.
 */
export const gateAsk = (gate, id, askTool) => {
  if (!ASK_GATES.includes(gate)) return null
  if (typeof id !== "string" || !id) return null
  if (typeof askTool !== "string" || !askTool) return null
  return taskGateAsk(id, askTool)
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
