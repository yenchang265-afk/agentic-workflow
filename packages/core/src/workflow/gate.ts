import path from "node:path"
import type { Client, Log, Shell } from "../host.js"
import type { Config } from "./state.js"
import { isSafeTaskId, parseTask, type Task } from "../task/schema.js"
import { appendNote, auditNote, findByIdIn, hasPlan, listByStatus, listClaimIds, moveTask, planRejectedNote, removeTaskFile, resolveTaskIdAnywhere, resolveTaskIdIn, STATUSES } from "../task/store.js"
import type { TaskStatus } from "../task/statuses.js"
import { requestPlan } from "../task/plan-request.js"
import { commitPaths, ensureExcluded, gitActor } from "./git.js"
import { releaseWorktree } from "./isolate.js"
import type { AdoGateway } from "../source/ado-gateway.js"
import { shipPr, type ShipPrResult } from "./ship-pr.js"

/**
 * The human gate moves — approve (task), approve-plan, replan, ship — shared by
 * both hosts. Previously hand-ported between the OpenCode driver (`doApprove`
 * etc., which toasted) and the Claude MCP server (`approveTask` etc., which
 * returned a structured result). This is the single source: each op locates the
 * task itself, performs the audited move + commit, and returns a `GateResult` the
 * host renders — the OpenCode driver toasts `message`, the Claude server feeds it
 * into its MCP `ok(...)` / CLI envelope. A retry that finds the task already at
 * the transition's target reports success (`alreadyDone`) so re-calls stay
 * harmless. Pure of host globals — everything comes through `GateCtx`.
 */

export interface GateCtx {
  readonly $: Shell
  readonly client: Client
  readonly log: Log
  readonly directory: string
  readonly config: Config
  /**
   * Whether a live loop is currently driving task `id` (refused by replan so we
   * never re-queue a task mid-build). The OpenCode host answers from its in-memory
   * session map; the Claude host from its single `active` loop or the on-disk stage
   * marker. Absent ⇒ nothing is driving.
   */
  readonly isDriving?: (id: string) => boolean
  /**
   * The Azure DevOps MCP gateway, for the ship gate's PR creation when the
   * engineering kind's platform is `ado`. Absent on a GitHub-only host — and
   * absent means the ship still succeeds, reporting only that no PR opened.
   */
  readonly adoGateway?: AdoGateway
}

/**
 * A result's severity, for hosts that surface it (the OpenCode toast, the hub's
 * message line). On a refusal: a task already at a forward status is `info`
 * ("nothing to do"), a genuine wrong-folder/not-found is `warning`.
 *
 * On a SUCCESS it marks a move that landed but carries a caveat — the ship gate
 * whose PR did not open is the case it exists for. Absent means an unqualified
 * success, which is what an ordinary move returns. The Claude host ignores it
 * (see `data` for the machine-readable half).
 */
export type GateVariant = "info" | "warning"

/**
 * A gate move's machine-readable half.
 *
 * `data.gate` (`"task" | "plan" | "ship"`) and `data.id` are the contract the
 * hosts branch on, and the approve family sets both on EVERY success arm — the
 * `alreadyDone` retries included. The unified `approve` verb is folder-driven,
 * so which gate it crossed is only knowable after the move; a host that needs to
 * act on it (the Claude/Qwen gate hook hands the turn back after a TASK gate,
 * instead of blocking it, so it can ask whether to plan now) must read it here.
 *
 * Never re-derive either from `message`: those strings are human prose that is
 * reworded freely, and matching on them is how a host silently starts guessing.
 * `data` is deliberately open (`Record<string, unknown>`) so verbs can add their
 * own keys — but these two are the shared vocabulary, matching the `gate: {kind,
 * id}` descriptor the MCP server already emits at its plan and ship gates.
 */
export type GateResult =
  | { readonly ok: true; readonly message: string; readonly path: string; readonly data: Record<string, unknown>; readonly variant?: GateVariant }
  | { readonly ok: false; readonly message: string; readonly variant?: GateVariant }

/**
 * Commit the backlog move, unless `config.ignoreBacklog` (the default) says to
 * leave it alone — then just re-assert the `.git/info/exclude` entry instead.
 *
 * Exported for callers that write to a task file *outside* a gate move and must
 * commit it the same way (the hub's task editor). They must not re-derive the
 * `ignoreBacklog` policy — it lives here, once.
 */
export const commitBacklog = async ($: Shell, directory: string, config: Config, message: string): Promise<void> => {
  if (config.ignoreBacklog) {
    await ensureExcluded($, directory, config.tasksDir)
    return
  }
  await commitPaths($, directory, [config.tasksDir], message)
}

/** Locate which status folder a task id lives in (searches all statuses). */
export const findAnyStatus = async (ctx: GateCtx, id: string): Promise<Task | null> => {
  for (const s of STATUSES) {
    const t = await findByIdIn(ctx.$, ctx.directory, ctx.config.tasksDir, s, id)
    if (t) return t
  }
  return null
}

const statusFolder = (t: Task): string => path.basename(path.dirname(t.path))

/**
 * When every parse-based lookup missed, check whether an id-named FILE still
 * exists in some status folder — i.e. the task is right there on disk but its
 * frontmatter can't be parsed (`findByIdIn` swallows parse errors to null).
 * Returning that diagnosis instead of "no task found" stops the gate from
 * sending the human hunting for a file they can see. Null when the file is
 * genuinely absent (or parseable — then a parse-based lookup would have hit).
 */
const unparseableAt = async (ctx: GateCtx, id: string): Promise<string | null> => {
  // Every other id-taking helper (findByIdIn, resolveTaskIdIn, moveTask,
  // removeTaskFile, rewriteTask, loadState) gates on this; this one did not, and
  // it is reachable with a RAW id: `resolveGateId` returns null for an id the
  // store refuses, and each caller then carries the user's original string on to
  // its "no task found" branch. `cat`ing it made this a filesystem existence
  // oracle — and the message embeds the parse error, which quotes the offending
  // line back out of whatever it read.
  if (!id || !isSafeTaskId(id)) return null
  for (const s of STATUSES) {
    const file = path.join(ctx.directory, ctx.config.tasksDir, s, `${id}.md`)
    const out = await ctx.$`cat ${file}`.quiet().nothrow()
    if (out.exitCode !== 0) continue
    try {
      parseTask(`${id}.md`, out.stdout.toString(), file)
      return null
    } catch (err) {
      return `Task file ${ctx.config.tasksDir}/${s}/${id}.md exists but can't be parsed — fix its frontmatter: ${(err as Error).message}`
    }
  }
  return null
}

/**
 * Resolve a user-typed id — which may be a short-hash prefix (`f7k3`) rather than
 * the full `f7k3-add-rate-limit` — to the single canonical task id across all
 * status folders. An exact filename hit always wins; a prefix hitting several tasks
 * is a warning-variant ambiguity error. Returns `{ id }` to proceed, `{ error }` to
 * surface, or `null` when nothing matched (callers keep their own "no task found"
 * messaging). An empty query passes straight through (the folder-driven auto-gate).
 */
const resolveGateId = async (ctx: GateCtx, query: string): Promise<{ id: string } | { error: GateResult } | null> => {
  if (!query) return { id: query }
  const { $, directory, config, log } = ctx
  const r = await resolveTaskIdAnywhere($, directory, config.tasksDir, query, log)
  if (!r) return null
  if ("id" in r) return r
  return { error: { ok: false, message: `Ambiguous id "${query}" — matches ${r.ambiguous.join(", ")}. Use more characters.`, variant: "warning" } }
}

/**
 * Append a gate move's audit note, then perform the move — and when the move
 * fails, correct the note instead of leaving it asserting something untrue.
 *
 * Every gate verb has to write its note first: the note belongs to the file, and
 * after a successful move the file is somewhere else. But `moveTask` THROWS on a
 * duplicate destination, a failed `mv`, or a move that didn't land — and an
 * unguarded throw escapes a function whose contract is `GateResult`, so the
 * caller's commit, PR and worktree release never run while the task file claims
 * a transition it never made. That combination is unrecoverable by reading the
 * backlog, which is the only record a human has.
 *
 * So the pairing lives here rather than being re-derived per verb: one place
 * that owns "note, move, and on failure say so". `terminal.ts` runs the same
 * protocol for the loop's own terminal moves.
 */
const noteThenMove = async (
  ctx: GateCtx,
  ref: { readonly id: string; readonly path: string },
  to: TaskStatus,
  note: string,
  actor?: string | null,
): Promise<{ ok: true; path: string } | { ok: false; result: GateResult }> => {
  const { $, log } = ctx
  await appendNote($, ref, auditNote(note, new Date(), actor), log)
  try {
    return { ok: true, path: await moveTask($, ref, to) }
  } catch (err) {
    const why = (err as Error).message
    await log("warn", `loop(${ref.id}): move to ${to}/ failed after its audit note: ${why}`)
    await appendNote($, ref, auditNote(`Move to ${to}/ failed — ${why}; the task did not move`, new Date(), actor), log)
    return { ok: false, result: { ok: false, message: `Can't move "${ref.id}" to ${to}/: ${why}`, variant: "warning" } }
  }
}

/** approve: a reviewed draft/ task → queued/ (audited note + commit). */
export const approveTask = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const draft = await findByIdIn($, directory, config.tasksDir, "draft", id)
  if (!draft) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    // A retry (model re-calling after a prior success, or a race with the
    // harness gate hook) lands here with the task already at the transition's
    // target — report success instead of an error so retries stay harmless.
    if (where === "queued") {
      return {
        ok: true,
        message: `Task "${elsewhere!.title}" is already queued in ${config.tasksDir}/queued/ — nothing to do.`,
        path: elsewhere!.path,
        data: { approved: true, alreadyDone: true, gate: "task", id, path: elsewhere!.path, next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage` },
      }
    }
    return {
      ok: false,
      message: where
        ? `Can't approve "${id}": it's in ${where} — only draft tasks can be approved.`
        : ((await unparseableAt(ctx, id)) ?? `Can't approve "${id}": no task found.`),
    }
  }
  // A tracking epic is never approved — it only orders its child slices;
  // queuing it would have the loop plan/build the tracking file itself.
  if (draft.type === "epic") {
    return {
      ok: false,
      message: `Can't approve "${id}": it is a tracking epic — approve its child slices instead, and close the epic by hand once every child has shipped.`,
      variant: "warning",
    }
  }
  const actor = await gitActor($, directory)
  const moved = await noteThenMove(ctx, draft, "queued", "Task approved — queued for planning", actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): task approved — queued for planning`)
  return {
    ok: true,
    message: `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/ for planning.`,
    path: newPath,
    data: { approved: true, gate: "task", id, path: newPath, next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage` },
  }
}

/**
 * retask: prepare a task for re-shaping by the authoring interview.
 *
 * A `draft/` task is already in the right place, so this is a no-op that reports
 * success. An approved `queued/` task is sent BACK to `draft/` first: it is
 * planless, so nothing downstream breaks, but reshaping the goal invalidates the
 * task-gate approval, which must be re-taken. Moving it also keeps the authoring
 * agent honest — it only ever writes `draft/*.md`, so by the time it looks, the
 * file is where it expects, and it can never author a second copy under a live
 * task's id (the duplicate this used to risk).
 *
 * From `plan-review/` onward a plan exists, so `replan` is the right verb and
 * this refuses.
 */
export const retaskTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const draft = await findByIdIn($, directory, config.tasksDir, "draft", id)
  if (draft) {
    return {
      ok: true,
      message: `"${draft.title}" is a draft — reshape it.`,
      path: draft.path,
      data: { retask: true, alreadyDone: true, path: draft.path, id },
    }
  }
  const queued = await findByIdIn($, directory, config.tasksDir, "queued", id)
  if (!queued) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    return {
      ok: false,
      message: where
        ? `Can't retask "${id}": it's in ${where} — a task with a plan goes back via /agentic-workflow:engineering replan ${id}.`
        : ((await unparseableAt(ctx, id)) ?? `Can't retask "${id}": no task found.`),
      variant: "warning",
    }
  }
  // A queued task is claimed by `plan <id>` or by the claim walk's fallback to
  // the queued pool, and a crashed run can leave the marker behind either way —
  // moving the task would orphan it.
  const held = await listClaimIds($, directory, config.tasksDir, "queued")
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — release it first (/agentic-workflow:engineering doctor fix).`, variant: "warning" }
  }
  const actor = await gitActor($, directory)
  // Same shape as replan's: the reason is why the goal was wrong, and the task
  // file is the only place the next authoring pass will look for it.
  const why = reason ? ` — ${reason}` : ""
  const moved = await noteThenMove(ctx, queued, "draft", `Sent back to draft for re-shaping — approval withdrawn${why}`, actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): sent back to draft for re-shaping`)
  return {
    ok: true,
    message: `"${queued.title}" sent back to ${config.tasksDir}/draft/ — reshape it, then approve it again.`,
    path: newPath,
    data: { retask: true, path: newPath, id, next: `/agentic-workflow:engineering approve ${id} re-queues it once reshaped` },
  }
}

/**
 * What a user can actually recover a deleted task from, phrased for the config
 * they are actually running.
 *
 * `ignoreBacklog` DEFAULTS TO TRUE — the backlog is kept out of git entirely —
 * so the stock "git history keeps it" reassurance is false for most installs.
 * Lead with the default rather than the exception.
 */
const recoveryHint = (config: Config): string =>
  config.ignoreBacklog
    ? "the backlog is untracked (ignoreBacklog defaults to true), so this CANNOT be undone."
    : "the backlog is committed, so git history keeps a copy, but it cannot be undone from the working tree."

/**
 * remove: hard-delete a task from the backlog entirely.
 *
 * Unlike every other gate this does NOT move the task to another folder — the
 * file is removed and the removal committed, so the task leaves the active
 * backlog for good. Git history retains it ONLY when the backlog is tracked,
 * which is not the default (`ignoreBacklog: true`); prefer `abandonTask` when
 * the user wants the task out of the way rather than gone. Works from ANY
 * status folder: cleaning up a stale draft, a rejected plan, or a finished task
 * is all the same delete.
 *
 * Refuses a task a live loop is driving, or one still holding a claim marker —
 * deleting the file out from under a run would strand its worktree/marker.
 * Idempotent by design: an id that resolves to nothing is reported as success
 * (`alreadyDone`), matching `rm -f`, so a double-click or a retry after a prior
 * success stays harmless. Any worktree the task owned is released best-effort.
 *
 * **`force` is the confirmation.** Without it this resolves the id, runs every
 * guard, and reports what WOULD be deleted without touching the file. The CLI
 * hosts had no confirmation at all: Claude dispatches `remove` from a
 * UserPromptSubmit hook that then blocks the turn, so the verb prose telling the
 * model to "confirm the id first" could never run, and opencode deleted straight
 * out of `command.execute.before`. Only the hub — which has its own <Confirm> —
 * passed a decision the user had actually made. Since ids are prefix-resolvable,
 * a typo'd short handle could resolve to a different real task and delete it.
 */
export const removeTask = async (ctx: GateCtx, id: string, force = false): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const task = await findAnyStatus(ctx, id)
  if (!task) {
    // Genuinely gone → idempotent success. But an id-named file that merely
    // fails to parse is still removable — surface that so a broken task can be
    // deleted rather than reported "already removed".
    const unparseable = await unparseableAt(ctx, id)
    if (unparseable) return { ok: false, message: `Can't remove "${id}": ${unparseable}`, variant: "warning" }
    return { ok: true, message: `No task "${id}" — nothing to remove.`, path: "", data: { removed: true, alreadyDone: true, id } }
  }
  const from = statusFolder(task)
  // A claim marker means a loop may be mid-run on it; refuse rather than orphan
  // the marker (mirrors retask's guard). A stale one is cleared by doctor fix.
  const held = await listClaimIds($, directory, config.tasksDir, from)
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  if (!force) {
    return {
      ok: false,
      variant: "info",
      message:
        `Remove "${task.title}" (${id}) from ${config.tasksDir}/${from}/? This DELETES the task file — ` +
        `${recoveryHint(config)} Nothing has been deleted. Re-run with --force to confirm: ` +
        `/agentic-workflow:engineering remove ${id} --force`,
    }
  }
  const removed = await removeTaskFile($, { id, path: task.path })
  await commitBacklog($, directory, config, `loop(${id}): task removed from backlog`)
  // A parked in-progress/in-review task can own a worktree; free it so the
  // delete doesn't leave an orphan tree behind (best-effort, never throws).
  await releaseWorktree($, log, directory, config, id)
  return {
    ok: true,
    message: `"${task.title}" removed from ${config.tasksDir}/${from}/.`,
    path: removed,
    data: { removed: true, path: removed, id, from },
  }
}

/**
 * abandon: cancel a task by moving it to `abandoned/` — the reversible
 * counterpart to `remove`.
 *
 * `abandoned` has always been a first-class status: it is in the vocabulary,
 * `canTransition` already admits it from every non-terminal folder, and `status`
 * renders its count. What it never had was a way in. The only cancellation verb
 * users could reach was `remove`, which deletes; the docs told them to reach
 * `abandoned/` "by hand" — on opencode via a move tool that host does not even
 * register. So the counter was unreachable and the safe path went unused.
 *
 * Guards mirror `remove` exactly (live loop, claim marker), because the hazard
 * is the same: moving the file out from under a run strands its worktree and
 * marker. Unlike `remove` the file survives, so this needs no `--force`.
 */
export const abandonTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const task = await findAnyStatus(ctx, id)
  if (!task) {
    return { ok: false, message: (await unparseableAt(ctx, id)) ?? `No task "${id}" to abandon.`, variant: "warning" }
  }
  const from = statusFolder(task)
  if (from === "abandoned") {
    return { ok: true, message: `"${task.title}" is already abandoned.`, path: task.path, data: { abandoned: true, alreadyDone: true, id } }
  }
  // `completed` is terminal in the same sense abandoned is — a shipped task is
  // not cancellable, and store.ts's canTransition says so. Name the rule rather
  // than letting moveTask fail obscurely.
  if (from === "completed") {
    return { ok: false, message: `Can't abandon "${id}": it's already completed — shipped work isn't cancellable.`, variant: "warning" }
  }
  const held = await listClaimIds($, directory, config.tasksDir, from)
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  const why = reason?.trim()
  const moved = await noteThenMove(
    ctx,
    { id, path: task.path },
    "abandoned",
    `Abandoned from ${from}${why ? ` — ${why}` : ""}`,
    await gitActor($, directory),
  )
  // Same rule the terminal handlers follow: a thrown move must not escape a
  // function whose contract is GateResult, leaving a note asserting a move that
  // never happened. `noteThenMove` also corrects the note, which the local
  // try/catch this replaced did not.
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): abandoned${why ? ` — ${why}` : ""}`)
  // A parked task can own a worktree; free it the way remove/ship do.
  await releaseWorktree($, log, directory, config, id)
  return {
    ok: true,
    message: `"${task.title}" abandoned — moved to ${config.tasksDir}/abandoned/.`,
    path: newPath,
    data: { abandoned: true, path: newPath, id, from },
  }
}

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
export const approvePlan = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const task = await findByIdIn($, directory, config.tasksDir, "plan-review", id)
  if (!task) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "in-progress") {
      return {
        ok: true,
        message: `Plan for "${elsewhere!.title}" is already approved — parked in ${config.tasksDir}/in-progress/. Nothing to do.`,
        path: elsewhere!.path,
        data: { approved: true, alreadyDone: true, gate: "plan", id, path: elsewhere!.path, next: `workflow_start with id "${id}", or workflow_claim` },
      }
    }
    return {
      ok: false,
      message:
        where === "queued"
          ? `Can't approve the plan for "${id}": it's still queued — the loop hasn't planned it yet (workflow_start runs its PLAN stage).`
          : where === "draft"
            ? `Can't approve the plan for "${id}": it's a draft — approve the task first with workflow_task_approve.`
            : where
              ? `Can't approve the plan for "${id}": it's in ${where} — only plan-review tasks can be plan-approved.`
              : ((await unparseableAt(ctx, id)) ?? `Can't approve the plan for "${id}": no task found.`),
    }
  }
  // Host-neutral pointer: this message is surfaced verbatim on both hosts (the
  // OpenCode toast and the Claude tool result), so it names the `replan` verb
  // generically rather than a host-specific command/tool.
  if (!hasPlan(task)) return { ok: false, message: `Task "${id}" has no Implementation Plan — send it back to planning with replan.`, variant: "warning" }
  const actor = await gitActor($, directory)
  const moved = await noteThenMove(ctx, task, "in-progress", "Plan approved — parked for execution", actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): plan approved — parked for execution`)
  return {
    ok: true,
    message: `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/ for execution.`,
    path: newPath,
    data: { approved: true, gate: "plan", id, path: newPath, next: `workflow_start with id "${id}", or workflow_claim` },
  }
}

/**
 * A rejection reason flattened to one audit-note-safe line, or `undefined`.
 *
 * An audit note is a single `> …` line closed by a bracketed stamp; an embedded
 * newline breaks that shape — line 2 loses the `> ` prefix and the stamp
 * detaches — so neither the audit trail nor `extractReplanReason` (which
 * threads the reason into the next PLAN pass's prompt) can read it back. Pure.
 */
export const oneLineReason = (reason?: string): string | undefined => {
  const flat = reason?.replace(/\s+/g, " ").trim()
  return flat || undefined
}

/**
 * Stamp `id` plan-next so the next claim/watch walk re-plans it before the rest
 * of the queued pool. Best-effort — a missing marker only costs the scheduling
 * hint (the ordinary queue walk still re-plans the task), so a failed write
 * warns rather than failing the gate. Written AFTER the gate's commit so the
 * ephemeral marker never rides into a tracked backlog's replan commit.
 */
const markPlanNext = async (ctx: GateCtx, id: string, actor: string | null): Promise<void> => {
  const marked = await requestPlan(ctx.$, ctx.directory, ctx.config.tasksDir, id, { by: actor, source: "replan" })
  if (!marked) await ctx.log("warn", `loop(${id}): could not write the plan-next request marker — the task is queued but not prioritized`)
}

/**
 * replan aimed at a task already sitting in queued/ — the retry arm. A fresh
 * reason still matters: record it (the same note shape `extractReplanReason`
 * parses) and restamp the plan-next marker — unless a claim marker says a
 * planner holds the file RIGHT NOW: appending to a file the plan author is
 * rewriting is a lost update, and the run holding the claim is already doing
 * what this verb asks for.
 */
const replanQueued = async (ctx: GateCtx, task: Task, reason?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const id = task.id
  const held = await listClaimIds($, directory, config.tasksDir, "queued")
  if (held.includes(id)) {
    return {
      ok: false,
      message: `Task "${id}" is being planned right now — its revised plan will park in ${config.tasksDir}/plan-review/; replan that plan when it lands.`,
      variant: "info",
    }
  }
  const actor = await gitActor($, directory)
  const flat = oneLineReason(reason)
  if (flat) {
    await appendNote($, task, auditNote(planRejectedNote(flat), new Date(), actor), log)
    await commitBacklog($, directory, config, `loop(${id}): rejection reason recorded — marked plan-next`)
  }
  await markPlanNext(ctx, id, actor)
  return {
    ok: true,
    message: `"${task.title}" (${id}) is already queued in ${config.tasksDir}/queued/ — marked plan-next; the next PLAN pass re-plans it${flat ? " and addresses the new reason" : ""}.`,
    path: task.path,
    data: { requeued: true, alreadyDone: true, id, path: task.path, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it now` },
  }
}

/**
 * replan: a rejected plan-review/ or cap-tripped in-progress/ task → queued/,
 * stamped plan-next so the very next PLAN pass — a host chaining one
 * immediately, or the next claim/watch walk — picks it up first and parks a
 * revised plan back in plan-review/. `isDriving` refuses a task a live loop is
 * currently driving (so we never re-queue a task mid-build).
 */
export const replanTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  const task =
    (await findByIdIn($, directory, config.tasksDir, "plan-review", id)) ??
    (await findByIdIn($, directory, config.tasksDir, "in-progress", id))
  if (!task) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "queued") return replanQueued(ctx, elsewhere!, reason)
    return {
      ok: false,
      message: where
        ? `Can't replan "${id}": it's in ${where} — only plan-review or in-progress tasks can be sent back to planning.`
        : ((await unparseableAt(ctx, id)) ?? `Can't replan "${id}": no task found.`),
    }
  }
  // `isDriving` is PER-PROCESS — it walks an in-memory Map local to one plugin
  // instance — so a replan issued from the hub or the Claude MCP server sails
  // past it while an opencode loop is mid-BUILD, and the move then releases that
  // live run's claim marker out from under it. The marker is the cross-process
  // signal; retask and remove already check it, replan did not.
  const held = await listClaimIds($, directory, config.tasksDir, statusFolder(task))
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  const actor = await gitActor($, directory)
  // One formatter (`planRejectedNote`) for every rejection note — the park
  // gate's contract refusal writes the same shape, and `extractReplanReason`
  // parses it back; a hand-built copy here is how writer and parser drift.
  const moved = await noteThenMove(ctx, task, "queued", planRejectedNote(oneLineReason(reason)), actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): plan rejected — re-queued for planning`)
  await markPlanNext(ctx, id, actor)
  return {
    ok: true,
    // The id rides in the MESSAGE, not just `data` — on the Claude host the
    // model chains the next PLAN pass from this text alone (gate-command.mjs
    // surfaces only the message), and `workflow_start` needs a copyable id.
    message: `Plan rejected for "${task.title}" (${id}) — re-queued in ${config.tasksDir}/queued/ as plan-next; the next PLAN pass addresses the rejection and parks a revised plan in plan-review/.`,
    path: newPath,
    data: { requeued: true, id, path: newPath, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it now` },
  }
}

/**
 * The PR half of a ship, rendered onto the `GateResult.message` every surface
 * shows verbatim (opencode toast, the hub card).
 *
 * An unopened PR is a NOTE, not a failure. Opening one is not a requirement of
 * the ship: `shipPr` never throws, no-ops entirely for a hand-authored task with
 * no `feature/<id>` branch, and several of its reasons — `ado config missing`,
 * `ado.repository not configured` — are plain configuration states where a PR
 * was never possible. By the time it runs, the task is already audited, moved to
 * `completed/`, and committed. So the ship succeeded; this is the caveat.
 *
 * What it must not do is go SILENT, which is what it used to do: the reason went
 * only into an audit note, invisible under the default `ignoreBacklog: true`
 * that never commits it, and the user read an unqualified "completed".
 *
 * Deliberately says nothing about whether the branch was pushed. `attempted`
 * covers two worlds — `git push failed` (not pushed) and a `gh`/ADO create
 * failure (pushed) — and `ShipPrResult` does not distinguish them, so any claim
 * either way is wrong half the time.
 */
const prOutcome = (pr: ShipPrResult): string =>
  pr.url ? ` PR: ${pr.url}` : pr.attempted ? ` Note: no PR was opened — ${pr.reason ?? "reason unknown"}. The task is completed; open one when you're ready.` : ""

/** Whether a ship's PR attempt came up short — the one case that warrants a warning. */
const prMissed = (pr: ShipPrResult): boolean => pr.attempted && !pr.url

/** ship: an in-review/ task → completed/ (the final human gate). Opens/links the draft PR. */
export const shipTask = async (ctx: GateCtx, id: string, kind = "engineering"): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const t = await findByIdIn($, directory, config.tasksDir, "in-review", id)
  if (!t) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "completed") {
      // A crash between the completed/ move and shipPr (a slow network call)
      // leaves the task completed with the branch unpushed and NO PR — and this
      // retry is the only path back. shipPr is idempotent (push re-runs, an
      // existing PR is reused), so re-attempt it unless the task file already
      // records an opened/linked PR; then release the orphaned worktree.
      const done = elsewhere!
      const data: Record<string, unknown> = { completed: done.path, alreadyDone: true, gate: "ship", id }
      let tail = " Nothing to do."
      // Hoisted: `pr` is scoped to the re-attempt below, but the variant is
      // decided on the return. A retry that STILL can't open the PR warns for
      // the same reason the main path does.
      let missedPr = false
      const prAlreadyRecorded = /\bPR (opened|already open) — /.test(done.body)
      if (!prAlreadyRecorded) {
        const pr = await shipPr($, log, directory, config, kind, id, done.title, ctx.adoGateway)
        if (pr.url) {
          data.pr = { url: pr.url }
          await appendNote($, { id, path: done.path }, auditNote(`${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`, new Date()), log)
          await commitBacklog($, directory, config, `loop(${id}): PR ${pr.created ? "opened" : "linked"}`)
        } else if (pr.attempted) {
          data.pr = { opened: false, reason: pr.reason }
          await appendNote($, { id, path: done.path }, auditNote(`PR not opened — ${pr.reason}`, new Date()), log)
          await commitBacklog($, directory, config, `loop(${id}): PR not opened`)
        }
        // Same rule as the main path: a retry that still can't open the PR must
        // say so, not report "nothing to do".
        if (pr.url || pr.attempted) tail = prOutcome(pr)
        missedPr = prMissed(pr)
      }
      await releaseWorktree($, log, directory, config, id)
      return { ok: true, message: `"${done.title}" is already completed.${tail}`, path: done.path, data, ...(missedPr ? { variant: "warning" as const } : {}) }
    }
    return { ok: false, message: elsewhere ? `Can't ship "${id}": it's in ${where}, not in-review/.` : ((await unparseableAt(ctx, id)) ?? `No in-review task "${id}".`) }
  }
  const moved = await noteThenMove(ctx, { id, path: t.path }, "completed", "Shipped — moved to completed", await gitActor($, directory))
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): shipped — completed`)

  const pr = await shipPr($, log, directory, config, kind, id, t.title, ctx.adoGateway)
  const data: Record<string, unknown> = { completed: newPath, gate: "ship", id }
  if (pr.url) {
    data.pr = { url: pr.url }
    await appendNote($, { id, path: newPath }, auditNote(`${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`, new Date()), log)
    await commitBacklog($, directory, config, `loop(${id}): PR ${pr.created ? "opened" : "linked"}`)
  } else if (pr.attempted) {
    data.pr = { opened: false, reason: pr.reason }
    await appendNote($, { id, path: newPath }, auditNote(`PR not opened — ${pr.reason}`, new Date()), log)
    await commitBacklog($, directory, config, `loop(${id}): PR not opened`)
  }
  // The task is done: its worktree — kept across every earlier run so retries
  // and recoveries build on prior iterations — is finally disposable. The
  // branch survives, so the PR opened just above is unaffected.
  await releaseWorktree($, log, directory, config, id)
  // A caveated ship is still a ship: `ok` stays true (the CLI exits 0, no host
  // reads it as a refusal) and the variant is what makes the note VISIBLE rather
  // than a green toast the user scrolls past.
  return { ok: true, message: `"${t.title}" completed.${prOutcome(pr)}`, path: newPath, data, ...(prMissed(pr) ? { variant: "warning" as const } : {}) }
}

/** Which task a folder-driven gate shortcut should act on. */
export type GatePick =
  | { readonly ok: true; readonly id: string; readonly from: TaskStatus }
  | { readonly ok: false; readonly kind: "none" }
  | { readonly ok: false; readonly kind: "message"; readonly message: string; readonly variant: GateVariant }

/** Statuses "ahead" of every gate — a task there has already advanced, so a gate no-op is informational, not an error. */
const FORWARD_STATUSES: readonly TaskStatus[] = ["queued", "in-progress", "completed"]

/**
 * Resolve the single task a shortcut should act on.
 *
 * `tiers` are searched in priority order. With `id`: the task must be in some
 * folder across all tiers (flattened — priority is irrelevant, since a task
 * lives in exactly one folder). Without `id`: the *first tier with any
 * candidate* decides — exactly one candidate there advances, two+ is an
 * ambiguity within that tier. So a lower tier never breaks a higher tier's tie,
 * and a non-empty higher tier is never bypassed. Every tier empty → `none`.
 * Never guesses.
 *
 * `skip` drops candidates from the id-less scan only. An explicit id always
 * reaches its task, so the specific gate op still reports why it can't advance.
 */
export const resolveGateTask = async (
  ctx: GateCtx,
  id: string,
  tiers: readonly (readonly TaskStatus[])[],
  skip?: (task: Task) => boolean,
): Promise<GatePick> => {
  const { $, client, directory, config, log } = ctx
  if (id) {
    const resolved = await resolveGateId(ctx, id)
    if (resolved && "error" in resolved) return { ok: false, kind: "message", message: resolved.error.message, variant: "warning" }
    if (resolved) id = resolved.id
    for (const from of tiers.flat()) {
      const t = await findByIdIn($, directory, config.tasksDir, from, id)
      if (t) return { ok: true, id, from }
    }
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    // A forward status means the move already happened — informational, not an error.
    const variant: GateVariant = where && FORWARD_STATUSES.includes(where as TaskStatus) ? "info" : "warning"
    const message = where ? `"${id}" is in ${where} — nothing to do.` : ((await unparseableAt(ctx, id)) ?? `No task "${id}" found.`)
    return { ok: false, kind: "message", message, variant }
  }
  for (const tier of tiers) {
    const found: { id: string; from: TaskStatus }[] = []
    for (const from of tier) {
      for (const t of await listByStatus(client, directory, config.tasksDir, from, log)) {
        if (!skip?.(t)) found.push({ id: t.id, from })
      }
    }
    if (found.length === 1) return { ok: true, ...found[0]! }
    if (found.length > 1) {
      const list = found.map((f) => `${f.id} (${f.from})`).join(", ")
      return { ok: false, kind: "message", message: `Multiple tasks awaiting: ${list} — pass an id.`, variant: "warning" }
    }
  }
  return { ok: false, kind: "none" }
}

/**
 * approve shortcut — the unified, folder-driven gate. With an explicit `id` it
 * advances that task by the gate its folder implies: draft/ → queued (task gate),
 * plan-review/ → in-progress (plan gate), or in-review/ → completed (ship).
 * Without an id it advances the single task at a loop wait-gate (plan-review/ or
 * in-review/); only when *nothing* waits at either does it fall back to draft/.
 * The loop's own gates always outrank the authoring gate, so a parked plan is
 * never shadowed by a pile of drafts. Tracking epics are skipped in the id-less
 * scan — they are never approvable, so they must not create a false ambiguity.
 */
export const approveAny = async (ctx: GateCtx, id: string, kind = "engineering"): Promise<GateResult> => {
  const tiers: readonly (readonly TaskStatus[])[] = [["plan-review", "in-review"], ["draft"]]
  const pick = await resolveGateTask(ctx, id, tiers, (t) => t.type === "epic")
  if (!pick.ok) {
    return pick.kind === "none"
      ? { ok: false, message: "Nothing awaiting approval.", variant: "info" }
      : { ok: false, message: pick.message, variant: pick.variant }
  }
  if (pick.from === "draft") return approveTask(ctx, pick.id)
  if (pick.from === "plan-review") return approvePlan(ctx, pick.id)
  return shipTask(ctx, pick.id, kind) // in-review
}

/** ship shortcut: id optional — ships the single in-review/ task when omitted. */
export const shipAny = async (ctx: GateCtx, id: string, kind = "engineering"): Promise<GateResult> => {
  if (id) return shipTask(ctx, id, kind)
  const pick = await resolveGateTask(ctx, "", [["in-review"]])
  if (!pick.ok) {
    return pick.kind === "none" ? { ok: false, message: "Nothing awaiting ship.", variant: "info" } : { ok: false, message: pick.message, variant: pick.variant }
  }
  return shipTask(ctx, pick.id, kind)
}

/**
 * reject shortcut: send a parked plan back to queued/ for re-planning. Auto-targets
 * the single plan-review/ task; an explicit leading id may also name a cap-tripped
 * in-progress/ task, with the rest of `arg` as the reason. When no leading token
 * names a rejectable task, the whole `arg` is the reason.
 */
export const rejectAny = async (ctx: GateCtx, arg: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const [first = "", ...restParts] = arg.trim().split(/\s+/).filter(Boolean)
  if (first) {
    // Resolve the leading token as a task id the same way `approve` does — so the
    // short-hash handle the UIs surface (`f7k3`) targets the task instead of being
    // silently folded into the rejection reason. A hash that matches several tasks
    // in a rejectable folder is an ambiguity to surface, not a reason word.
    for (const from of ["plan-review", "in-progress"] as const) {
      const r = await resolveTaskIdIn($, directory, config.tasksDir, from, first, log)
      if (r && "id" in r) return replanTask(ctx, r.id, restParts.join(" ").trim() || undefined)
      if (r && "ambiguous" in r) {
        return { ok: false, message: `Ambiguous id "${first}" — matches ${r.ambiguous.join(", ")}. Use more characters.`, variant: "warning" }
      }
    }
  }
  const pick = await resolveGateTask(ctx, "", [["plan-review"]])
  if (!pick.ok) {
    return pick.kind === "none" ? { ok: false, message: "No plan awaiting rejection.", variant: "info" } : { ok: false, message: pick.message, variant: pick.variant }
  }
  return replanTask(ctx, pick.id, arg.trim() || undefined)
}
