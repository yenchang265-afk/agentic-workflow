import path from "node:path"
import type { Client, Log, Shell } from "../host.js"
import type { Config } from "./state.js"
import { parseTask, type Task } from "../task/schema.js"
import { appendNote, auditNote, findByIdIn, hasPlan, listByStatus, listClaimIds, moveTask, removeTaskFile, resolveTaskIdAnywhere, resolveTaskIdIn, STATUSES } from "../task/store.js"
import type { TaskStatus } from "../task/statuses.js"
import { commitPaths, ensureExcluded, gitActor } from "./git.js"
import { releaseWorktree } from "./isolate.js"
import { shipPr } from "./ship-pr.js"

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
}

/**
 * A refusal's severity, for hosts that surface it (the OpenCode toast): a task
 * already at a forward status is `info` ("nothing to do"), a genuine
 * wrong-folder/not-found is `warning`. The Claude host ignores it.
 */
export type GateVariant = "info" | "warning"

export type GateResult =
  | { readonly ok: true; readonly message: string; readonly path: string; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly variant?: GateVariant }

/**
 * Commit the backlog move, unless `config.ignoreBacklog` (the default) says to
 * leave it alone — then just re-assert the `.git/info/exclude` entry instead.
 */
const commitBacklog = async ($: Shell, directory: string, config: Config, message: string): Promise<void> => {
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
  if (!id) return null
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

/** approve: a reviewed draft/ task → queued/ (audited note + commit). */
export const approveTask = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
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
        data: { approved: true, alreadyDone: true, path: elsewhere!.path, next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage` },
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
  await appendNote($, draft, auditNote("Task approved — queued for planning", new Date(), actor), log)
  const newPath = await moveTask($, draft, "queued")
  await commitBacklog($, directory, config, `loop(${id}): task approved — queued for planning`)
  return {
    ok: true,
    message: `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/ for planning.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage` },
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
export const retaskTask = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
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
  // A queued task is claimed only by an explicit `plan <id>`, but a crashed run
  // can leave the marker behind — moving the task would orphan it.
  const held = await listClaimIds($, directory, config.tasksDir, "queued")
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — release it first (/agentic-workflow:engineering doctor fix).`, variant: "warning" }
  }
  const actor = await gitActor($, directory)
  await appendNote($, queued, auditNote("Sent back to draft for re-shaping — approval withdrawn", new Date(), actor), log)
  const newPath = await moveTask($, queued, "draft")
  await commitBacklog($, directory, config, `loop(${id}): sent back to draft for re-shaping`)
  return {
    ok: true,
    message: `"${queued.title}" sent back to ${config.tasksDir}/draft/ — reshape it, then approve it again.`,
    path: newPath,
    data: { retask: true, path: newPath, id, next: `/agentic-workflow:engineering approve ${id} re-queues it once reshaped` },
  }
}

/**
 * remove: hard-delete a task from the backlog entirely.
 *
 * Unlike every other gate this does NOT move the task to another folder — the
 * file is removed and the removal committed, so the task leaves the active
 * backlog for good (git history retains it if the backlog is tracked). Works
 * from ANY status folder: cleaning up a stale draft, a rejected plan, or a
 * finished task is all the same delete.
 *
 * Refuses a task a live loop is driving, or one still holding a claim marker —
 * deleting the file out from under a run would strand its worktree/marker.
 * Idempotent by design: an id that resolves to nothing is reported as success
 * (`alreadyDone`), matching `rm -f`, so a double-click or a retry after a prior
 * success stays harmless. Any worktree the task owned is released best-effort.
 */
export const removeTask = async (ctx: GateCtx, id: string): Promise<GateResult> => {
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

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
export const approvePlan = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
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
        data: { approved: true, alreadyDone: true, path: elsewhere!.path, next: `workflow_start with id "${id}", or workflow_claim` },
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
  await appendNote($, task, auditNote("Plan approved — parked for execution", new Date(), actor), log)
  const newPath = await moveTask($, task, "in-progress")
  await commitBacklog($, directory, config, `loop(${id}): plan approved — parked for execution`)
  return {
    ok: true,
    message: `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/ for execution.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `workflow_start with id "${id}", or workflow_claim` },
  }
}

/**
 * replan: a rejected plan-review/ or cap-tripped in-progress/ task → queued/.
 * `liveTaskId` is the id of the task a live loop is currently driving (refused so
 * we never re-queue a task mid-build).
 */
export const replanTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
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
    if (where === "queued") {
      return {
        ok: true,
        message: `"${elsewhere!.title}" is already queued in ${config.tasksDir}/queued/ — nothing to do.`,
        path: elsewhere!.path,
        data: { requeued: true, alreadyDone: true, path: elsewhere!.path, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it` },
      }
    }
    return {
      ok: false,
      message: where
        ? `Can't replan "${id}": it's in ${where} — only plan-review or in-progress tasks can be sent back to planning.`
        : ((await unparseableAt(ctx, id)) ?? `Can't replan "${id}": no task found.`),
    }
  }
  const actor = await gitActor($, directory)
  const why = reason ? ` — ${reason}` : ""
  await appendNote($, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor), log)
  const newPath = await moveTask($, task, "queued")
  await commitBacklog($, directory, config, `loop(${id}): plan rejected — re-queued for planning`)
  return {
    ok: true,
    message: `"${task.title}" sent back to ${config.tasksDir}/queued/ — the next PLAN pass will address the rejection.`,
    path: newPath,
    data: { requeued: true, path: newPath, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it` },
  }
}

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
      const data: Record<string, unknown> = { completed: done.path, alreadyDone: true }
      let prUrl: string | undefined
      const prAlreadyRecorded = /\bPR (opened|already open) — /.test(done.body)
      if (!prAlreadyRecorded) {
        const pr = await shipPr($, log, directory, config, kind, id, done.title)
        if (pr.url) {
          prUrl = pr.url
          data.pr = { url: pr.url }
          await appendNote($, { id, path: done.path }, auditNote(`${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`, new Date()), log)
          await commitBacklog($, directory, config, `loop(${id}): PR ${pr.created ? "opened" : "linked"}`)
        } else if (pr.attempted) {
          await appendNote($, { id, path: done.path }, auditNote(`PR not opened — ${pr.reason}`, new Date()), log)
          await commitBacklog($, directory, config, `loop(${id}): PR not opened`)
        }
      }
      await releaseWorktree($, log, directory, config, id)
      return { ok: true, message: `"${done.title}" is already completed.${prUrl ? ` PR: ${prUrl}` : " Nothing to do."}`, path: done.path, data }
    }
    return { ok: false, message: elsewhere ? `Can't ship "${id}": it's in ${where}, not in-review/.` : ((await unparseableAt(ctx, id)) ?? `No in-review task "${id}".`) }
  }
  await appendNote($, { id, path: t.path }, auditNote("Shipped — moved to completed", new Date(), await gitActor($, directory)), log)
  const newPath = await moveTask($, { id, path: t.path }, "completed")
  await commitBacklog($, directory, config, `loop(${id}): shipped — completed`)

  const pr = await shipPr($, log, directory, config, kind, id, t.title)
  const data: Record<string, unknown> = { completed: newPath }
  if (pr.url) {
    data.pr = { url: pr.url }
    await appendNote($, { id, path: newPath }, auditNote(`${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`, new Date()), log)
    await commitBacklog($, directory, config, `loop(${id}): PR ${pr.created ? "opened" : "linked"}`)
  } else if (pr.attempted) {
    await appendNote($, { id, path: newPath }, auditNote(`PR not opened — ${pr.reason}`, new Date()), log)
    await commitBacklog($, directory, config, `loop(${id}): PR not opened`)
  }
  // The task is done: its worktree — kept across every earlier run so retries
  // and recoveries build on prior iterations — is finally disposable. The
  // branch survives, so the PR opened just above is unaffected.
  await releaseWorktree($, log, directory, config, id)
  return { ok: true, message: `"${t.title}" completed.${pr.url ? ` PR: ${pr.url}` : ""}`, path: newPath, data }
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
