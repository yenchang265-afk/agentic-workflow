/**
 * The gate follow-up injected after a gate verb's DETERMINISTIC move.
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
 * The gates worth a follow-up question.
 *
 * `ship` is terminal — nothing follows a completed task. `plan` is deliberately
 * absent: the question after a plan gate is "build it now?", and building on one
 * word is a much bigger commitment than planning on one. `workflow-orchestration`
 * requires a separate explicit answer before a build, so that arm stays with the
 * interactive flow that can honour it.
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
