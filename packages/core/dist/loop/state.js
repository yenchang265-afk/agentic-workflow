/**
 * Loop state machine for the agentic loop:
 *
 *   plan → (park for plan review) · build → verify → review
 *
 * The types and state constructors here are **pure**. The transition logic
 * lives in `engine.ts`, interpreting a loop kind's manifest (the engineering
 * pipeline above is `loops/engineering/loop.json`); the impure orchestration
 * lives in each host's driver.
 *
 * Task authoring happens **before** the loop, in the `/agent-loop-task`
 * command: `new` interviews the user into a draft task and `approve <id>`
 * parks it planless in `queued/`. The loop claims a queued task and enters at
 * `plan` via `startAtPlan` — the PLAN stage writes the task's
 * `## Implementation Plan` right before execution, so plans don't rot while a
 * task sits parked. PLAN never blocks on a human: it terminates with a `park`
 * action (the driver moves the task to `plan-review/` and the loop exits).
 * `/agent-loop-task approve-plan <id>` is the human plan gate; the next claim
 * enters at `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * sends the task back to the PLAN stage via `/agent-loop-task replan <id>`.
 */
/** The engineering loop's stages in order. `plan` terminates with a park, not an advance. */
export const STAGES = ["plan", "build", "verify", "review"];
/**
 * The code-management platforms PR-shaped work sources can talk to — the single
 * source of truth. `ado` reaches Azure DevOps through the `az` CLI; `ado-mcp`
 * reaches the same Azure DevOps through the Microsoft ADO MCP server, with data
 * gathered by an agent session and handed back to the source (see
 * `source/ado-mcp-pr.ts`). Both share the `ado` config section.
 */
export const CODE_PLATFORMS = ["github", "ado", "ado-mcp"];
/** Construct a LoopState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agent-loop-task approve-plan`. */
export const resumeAtBuild = (goal, task, plan) => ({
    goal,
    stage: "build",
    iteration: 0,
    artifacts: { plan },
    task,
});
/** Construct a LoopState entering at the PLAN stage, for a claimed `queued/`
 *  task. `priorPlan` carries a rejected/capped plan on a replan so the new
 *  plan addresses why the old one failed instead of repeating it. */
export const startAtPlan = (goal, task, priorPlan) => ({
    goal,
    stage: "plan",
    iteration: 0,
    artifacts: priorPlan ? { plan: priorPlan } : {},
    task,
});
// --- In-memory store (lost on opencode restart; see README known limitations) ---
const store = new Map();
export const getLoop = (sessionID) => store.get(sessionID);
/** The session whose live loop is driving the given task id, if any (this plugin instance only). */
export const findSessionDriving = (taskId) => {
    for (const [sessionID, state] of store)
        if (state.task?.id === taskId)
            return sessionID;
    return undefined;
};
export const setLoop = (sessionID, state) => void store.set(sessionID, state);
export const clearLoop = (sessionID) => store.delete(sessionID);
export const hasLoop = (sessionID) => store.has(sessionID);
