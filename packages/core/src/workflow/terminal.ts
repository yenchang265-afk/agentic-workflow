import type { Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { resolveValidateHook } from "../manifest/registry.js"
import { appendNote, auditNote, findByIdIn, hasPlan, moveTask, releaseClaim } from "../task/store.js"
import type { TaskStatus } from "../task/statuses.js"
import { clearState } from "./persist.js"
import { loopId, releaseWorktreeAt, teardownIsolation } from "./isolate.js"
import type { Action, Config, LoopState } from "./state.js"
import type { Outcome } from "./metrics.js"

/**
 * The terminal bookkeeping shared by both hosts — what happens when a loop's
 * pure state machine yields a `park`, `done`, or `stop` action. Previously
 * hand-ported between the OpenCode driver's `drive` switch (which toasted) and
 * the Claude MCP server's `runPark`/`runTerminal` (which returned MCP
 * descriptors), the two copies had drifted: the Claude host never ran the
 * manifest's `validateBeforeTransition` veto, and the isolated-gating that keeps
 * a never-isolated stage (pr-sitter `triage` → done) from mutating the human's
 * main tree lived independently in each. This is the single source: it performs
 * the audited move + backlog commit + metrics + isolation teardown, gating every
 * main-tree write on `state.isolated` (the B5 fix, centralized), and returns a
 * structured `TerminalReport` each host renders — the OpenCode driver toasts, the
 * Claude server serializes a gate/next descriptor. Sibling of `gate.ts`.
 *
 * Everything host-specific comes through `TerminalCtx` ports: `commitBacklog`
 * (the main-tree backlog commit strategy), `checkpoint` (the work-tree commit-all
 * strategy — called only when isolated), and `writeMetrics` (the run summary +
 * structured sidecar, which observe tokens/sessionID differently per host). The
 * control flow — veto, plan-landed check, task move, ordering, isolated-gating —
 * is shared here.
 *
 * Ordering invariant: on done/stop the work-tree checkpoint + isolation teardown
 * run BEFORE any backlog write. In shared-tree mode the main tree sits on
 * `feature/<id>` until teardown, so a task move or note made earlier would be
 * committed onto the loop branch and vanish from the human branch at the teardown
 * checkout — the loop reports "done" while the human's backlog still shows the
 * task in in-progress/, and the ship gate can't find it.
 */

export interface TerminalCtx {
  readonly $: Shell
  readonly log: Log
  readonly directory: string
  readonly config: Config
  /** The loop state reaching the terminal event. */
  readonly state: LoopState
  /** The claimed kind's manifest — its `validateBeforeTransition` veto runs here. */
  readonly manifest: LoadedManifest
  /** git identity for audit notes (resolved once by the host; null outside a repo). */
  readonly actor: string | null
  /**
   * Commit the backlog (tasksDir) on the MAIN tree — the host's strategy
   * (OpenCode serializes via its per-tree commit lock; Claude calls commitPaths).
   * Core decides WHEN to call it: on every park, done-move, and stop note —
   * always after the work-tree checkpoint + teardown, so in shared-tree mode
   * the commit lands on the human branch, never on the loop branch.
   */
  readonly commitBacklog: (message: string) => Promise<void>
  /**
   * Commit everything on the loop's work tree as a checkpoint — the host's
   * strategy (OpenCode wraps commitAll in its commit lock; Claude calls commitAll
   * on its work tree). Called by core ONLY when `state.isolated`.
   */
  readonly checkpoint: (message: string) => Promise<void>
  /**
   * Render this run's summary into the run log and write the structured metrics
   * sidecar — the host's strategy (the accumulated samples, the observing host
   * label, and the driving sessionID all differ per host).
   */
  readonly writeMetrics: (outcome: Outcome, detail: string) => Promise<void>
}

/**
 * The structured outcome of terminal handling, mirroring `gate.ts`'s
 * `GateResult`. Each host maps it to its own presentation:
 * - `park`      — PLAN wrote a plan; the task parked in plan-review/ for the human gate.
 * - `park-free` — a free-text (task-less) plan park; nothing moved.
 * - `error`     — the park was vetoed, or PLAN wrote no plan; the task stays put.
 * - `done`      — the loop finished; the task parked in in-review/ (`moved`) for diff review.
 * - `stop`      — the loop stopped incomplete; partial work preserved on `branch`.
 */
export type TerminalReport =
  | { readonly kind: "park"; readonly taskId: string; readonly path: string; readonly message: string }
  | { readonly kind: "park-free"; readonly message: string }
  | { readonly kind: "error"; readonly message: string; readonly taskId?: string }
  | { readonly kind: "done"; readonly message: string; readonly taskId?: string; readonly moved: boolean; readonly branch?: string }
  | { readonly kind: "stop"; readonly message: string; readonly taskId?: string; readonly branch?: string; readonly retryable?: boolean }

/**
 * Checkpoint the work tree and tear the isolation down — but ONLY when the loop
 * actually isolated. A source-pre-set `git` (naming the branch to isolate ONTO)
 * without `isolated` must NOT reach here: `checkpoint` would `git add -A && commit`
 * the human's main tree and `teardownIsolation` would check out the base branch on
 * it (the centralized B5 fix — both hosts route through this). Runs FIRST on
 * done/stop, before any backlog write — see the module doc's ordering invariant.
 */
const closeIsolation = async (ctx: TerminalCtx, checkpointMessage: string): Promise<void> => {
  const { $, directory, state, log } = ctx
  if (!state.isolated) return
  await ctx.checkpoint(checkpointMessage)
  await teardownIsolation($, log, directory, state)
}

/** park: PLAN finished — validate the plan landed, move the task to plan-review/, or veto. */
const runPark = async (ctx: TerminalCtx, action: Extract<Action, { kind: "park" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  // A manifest may name a pre-transition validator for this stage
  // (`hooks.validateBeforeTransition`); a registered hook returning a reason vetoes
  // the park. Resolving it HERE fixes the drift where only the OpenCode host honored
  // it. Engineering's plan-landed check is done explicitly below (its ref is a
  // registered pass-through); an unregistered ref throws — dangling refs fail loudly.
  const validate = resolveValidateHook(ctx.manifest.manifest.hooks.validateBeforeTransition[state.stage])
  const veto = validate ? await validate(state) : null
  if (veto) {
    await log("warn", `loop: ${state.stage} park vetoed by validator — ${veto}`)
    if (state.task) {
      const held = await findByIdIn($, directory, config.tasksDir, "queued", state.task.id)
      if (held) await releaseClaim($, held)
    }
    await ctx.writeMetrics("error", veto)
    return { kind: "error", message: `Park vetoed for "${state.task?.id ?? state.goal}" — ${veto}`, ...(state.task ? { taskId: state.task.id } : {}) }
  }
  // A free-text (task-less) loop has nothing to park onto — nothing moves.
  if (!state.task) return { kind: "park-free", message: action.message }
  const id = state.task.id
  // Validate the plan actually landed on disk before parking — a PLAN stage that
  // wrote nothing must not put a planless task in front of the human gate.
  const fresh = await findByIdIn($, directory, config.tasksDir, "queued", id)
  if (!fresh || !hasPlan(fresh)) {
    const why = fresh ? "the PLAN stage wrote no ## Implementation Plan" : "the task left queued/ mid-plan"
    await log("warn", `loop(${id}): not parking — ${why}`)
    if (fresh) {
      await appendNote($, fresh, auditNote(`PLAN stage failed — ${why}; still queued`, new Date(), actor), log)
      await releaseClaim($, fresh)
    }
    await ctx.writeMetrics("error", why)
    return { kind: "error", message: `PLAN failed for "${id}" — ${why}. It stays in queued/.`, taskId: id }
  }
  await appendNote($, fresh, auditNote("Plan written — parked for plan review", new Date(), actor), log)
  const newPath = await moveTask($, fresh, (action.toStatus ?? "plan-review") as TaskStatus) // also releases the queued/ claim marker
  await ctx.commitBacklog(`loop(${id}): plan written — parked for review`)
  await ctx.writeMetrics("done", "plan parked for review")
  return { kind: "park", taskId: id, path: newPath, message: action.message }
}

/** done: the loop finished — park the task in in-review/ for human diff review. */
const runDone = async (ctx: TerminalCtx, action: Extract<Action, { kind: "done" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  // Checkpoint + teardown FIRST — after this, a shared-tree main tree is back on
  // the base branch, so the note/move/commit below land where the human (and the
  // ship gate) will actually look.
  await closeIsolation(ctx, `loop(${loopId(state)}): done — review passed`)
  // A task-less loop (free-text goal, sitter kind) never reaches the ship gate —
  // the only other place a worktree is released — so a done here is its last
  // chance to reclaim the directory. The work is already checkpointed on the
  // branch; a stop keeps the worktree so `recover` can resume in it.
  if (!state.task && state.isolated && state.git?.worktree) {
    await releaseWorktreeAt($, log, directory, state.git.worktree, state.git.branch)
  }
  let moved = false
  if (state.task) {
    // Re-resolve the real current path (shell-authoritative) rather than trust the
    // claim-time state.task.path, which goes stale if the file moved since the claim.
    const cur = await findByIdIn($, directory, config.tasksDir, "in-progress", state.task.id)
    if (cur) {
      try {
        await appendNote($, cur, auditNote("Loop done — review passed, awaiting human diff review", new Date(), actor), log)
        await moveTask($, cur, (action.toStatus ?? "in-review") as TaskStatus)
        await ctx.commitBacklog(`loop(${state.task.id}): done — parked in in-review`)
        moved = true
      } catch (err) {
        await log("warn", `loop done but task move failed: ${(err as Error).message}`)
      }
    } else {
      await log("warn", `loop done but task ${state.task.id} not in in-progress/ — not moved`)
    }
  }
  await ctx.writeMetrics("done", "review passed")
  if (state.task) await clearState($, directory, config.tasksDir, state.task.id)
  return { kind: "done", message: action.message, moved, ...(state.task ? { taskId: state.task.id } : {}), ...(state.git ? { branch: state.git.branch } : {}) }
}

/** stop: the loop stopped incomplete — annotate the task and preserve partial work. */
const runStop = async (ctx: TerminalCtx, action: Extract<Action, { kind: "stop" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  await closeIsolation(ctx, `loop(${loopId(state)}): incomplete — ${action.message}`)
  if (state.task) {
    // Re-resolve the real current path (shell-authoritative) like runDone: the
    // claim-time state.task.path goes stale if the file moved since the claim, and
    // appendNote's `>>` would recreate a moved/deleted task file as a frontmatterless
    // ghost. Only PLAN runs out of queued/; every other stage runs out of in-progress/.
    const status: TaskStatus = state.stage === "plan" ? "queued" : "in-progress"
    const cur = await findByIdIn($, directory, config.tasksDir, status, state.task.id)
    if (cur) {
      await appendNote($, cur, auditNote(action.message, new Date(), actor), log)
      // A loop stopped mid-PLAN leaves the task in queued/ — release its claim marker
      // or no later claim can pick it up (there is no staleness sweep on every substrate).
      if (state.stage === "plan") await releaseClaim($, cur)
      await ctx.commitBacklog(`loop(${state.task.id}): stopped — ${action.message}`)
    } else {
      // The file left its folder mid-run (human move/delete). Never write to the stale
      // path — but still release the plan-claim marker best-effort: it lives in the
      // claim-time folder's .claims/, which state.task.path still locates.
      if (state.stage === "plan") await releaseClaim($, state.task)
      await log("warn", `loop(${state.task.id}): stopped but task not in ${status}/ — stop note skipped`)
    }
  }
  await ctx.writeMetrics("stopped", action.message)
  if (state.task) await clearState($, directory, config.tasksDir, state.task.id)
  return { kind: "stop", message: action.message, ...(state.task ? { taskId: state.task.id } : {}), ...(state.git ? { branch: state.git.branch } : {}), ...(action.retryable ? { retryable: true } : {}) }
}

/**
 * Run the terminal bookkeeping for a park/done/stop action and return a structured
 * report. Callers gate on `action.kind` being terminal (a `noop`/`fire` should never
 * reach here); an unexpected kind is a defensive no-op reported as an error.
 */
export const runTerminal = async (ctx: TerminalCtx, action: Action): Promise<TerminalReport> => {
  switch (action.kind) {
    case "park":
      return runPark(ctx, action)
    case "done":
      return runDone(ctx, action)
    case "stop":
      return runStop(ctx, action)
    default:
      return { kind: "error", message: `runTerminal called with non-terminal action "${action.kind}"` }
  }
}
