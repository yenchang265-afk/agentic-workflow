import path from "node:path"
import type { Client, Log, Shell } from "../host.js"
import type { Config } from "./state.js"
import type { Task } from "../task/schema.js"
import { appendNote, auditNote, findByIdIn, hasPlan, listByStatus, moveTask, resolveTaskIdIn, STATUSES } from "../task/store.js"
import type { TaskStatus } from "../task/statuses.js"
import { commitPaths, gitActor } from "./git.js"
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
  const prefix = new Set<string>()
  for (const s of STATUSES) {
    const r = await resolveTaskIdIn($, directory, config.tasksDir, s, query, log)
    if (!r) continue
    if ("id" in r) {
      if (r.id === query) return { id: query } // exact filename (full id or legacy slug) wins immediately
      prefix.add(r.id)
    } else for (const m of r.ambiguous) prefix.add(m)
  }
  if (prefix.size === 1) return { id: [...prefix][0]! }
  if (prefix.size > 1) {
    const list = [...prefix].sort().join(", ")
    return { error: { ok: false, message: `Ambiguous id "${query}" — matches ${list}. Use more characters.`, variant: "warning" } }
  }
  return null
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
        data: { approved: true, alreadyDone: true, path: elsewhere!.path, next: `loop_start with id "${id}" (or loop_claim) runs its PLAN stage` },
      }
    }
    return {
      ok: false,
      message: where ? `Can't approve "${id}": it's in ${where} — only draft tasks can be approved.` : `Can't approve "${id}": no task found.`,
    }
  }
  const actor = await gitActor($, directory)
  await appendNote($, draft, auditNote("Task approved — queued for planning", new Date(), actor), log)
  const newPath = await moveTask($, draft, "queued")
  await commitPaths($, directory, [config.tasksDir], `loop(${id}): task approved — queued for planning`)
  return {
    ok: true,
    message: `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/ for planning.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) runs its PLAN stage` },
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
        data: { approved: true, alreadyDone: true, path: elsewhere!.path, next: `loop_start with id "${id}", or loop_claim` },
      }
    }
    return {
      ok: false,
      message:
        where === "queued"
          ? `Can't approve the plan for "${id}": it's still queued — the loop hasn't planned it yet (loop_start runs its PLAN stage).`
          : where === "draft"
            ? `Can't approve the plan for "${id}": it's a draft — approve the task first with loop_task_approve.`
            : where
              ? `Can't approve the plan for "${id}": it's in ${where} — only plan-review tasks can be plan-approved.`
              : `Can't approve the plan for "${id}": no task found.`,
    }
  }
  // Host-neutral pointer: this message is surfaced verbatim on both hosts (the
  // OpenCode toast and the Claude tool result), so it names the `replan` verb
  // generically rather than a host-specific command/tool.
  if (!hasPlan(task)) return { ok: false, message: `Task "${id}" has no Implementation Plan — send it back to planning with replan.`, variant: "warning" }
  const actor = await gitActor($, directory)
  await appendNote($, task, auditNote("Plan approved — parked for execution", new Date(), actor), log)
  const newPath = await moveTask($, task, "in-progress")
  await commitPaths($, directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
  return {
    ok: true,
    message: `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/ for execution.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `loop_start with id "${id}", or loop_claim` },
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
  if (ctx.isDriving?.(id)) return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-loop:engineering stop).`, variant: "warning" }
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
        data: { requeued: true, alreadyDone: true, path: elsewhere!.path, next: `loop_start with id "${id}" (or loop_claim) re-plans it` },
      }
    }
    return {
      ok: false,
      message: where
        ? `Can't replan "${id}": it's in ${where} — only plan-review or in-progress tasks can be sent back to planning.`
        : `Can't replan "${id}": no task found.`,
    }
  }
  const actor = await gitActor($, directory)
  const why = reason ? ` — ${reason}` : ""
  await appendNote($, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor), log)
  const newPath = await moveTask($, task, "queued")
  await commitPaths($, directory, [config.tasksDir], `loop(${id}): plan rejected — re-queued for planning`)
  return {
    ok: true,
    message: `"${task.title}" sent back to ${config.tasksDir}/queued/ — the next PLAN pass will address the rejection.`,
    path: newPath,
    data: { requeued: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) re-plans it` },
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
      return { ok: true, message: `"${elsewhere!.title}" is already completed. Nothing to do.`, path: elsewhere!.path, data: { completed: elsewhere!.path, alreadyDone: true } }
    }
    return { ok: false, message: elsewhere ? `Can't ship "${id}": it's in ${where}, not in-review/.` : `No in-review task "${id}".` }
  }
  await appendNote($, { id, path: t.path }, auditNote("Shipped — moved to completed", new Date(), await gitActor($, directory)), log)
  const newPath = await moveTask($, { id, path: t.path }, "completed")
  await commitPaths($, directory, [config.tasksDir], `loop(${id}): shipped — completed`)

  const pr = await shipPr($, log, directory, config, kind, id, t.title)
  const data: Record<string, unknown> = { completed: newPath }
  if (pr.url) {
    data.pr = { url: pr.url }
    await appendNote($, { id, path: newPath }, auditNote(`${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`, new Date()), log)
    await commitPaths($, directory, [config.tasksDir], `loop(${id}): PR ${pr.created ? "opened" : "linked"}`)
  } else if (pr.attempted) {
    await appendNote($, { id, path: newPath }, auditNote(`PR not opened — ${pr.reason}`, new Date()), log)
    await commitPaths($, directory, [config.tasksDir], `loop(${id}): PR not opened`)
  }
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
 * Resolve the single task a shortcut should act on, searching `folders` in order.
 * With `id`: the task must be in one of `folders`. Without `id`: exactly one
 * candidate advances; zero → `none`; two+ → an ambiguity message (never guesses).
 */
export const resolveGateTask = async (ctx: GateCtx, id: string, folders: readonly TaskStatus[]): Promise<GatePick> => {
  const { $, client, directory, config, log } = ctx
  if (id) {
    const resolved = await resolveGateId(ctx, id)
    if (resolved && "error" in resolved) return { ok: false, kind: "message", message: resolved.error.message, variant: "warning" }
    if (resolved) id = resolved.id
    for (const from of folders) {
      const t = await findByIdIn($, directory, config.tasksDir, from, id)
      if (t) return { ok: true, id, from }
    }
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    // A forward status means the move already happened — informational, not an error.
    const variant: GateVariant = where && FORWARD_STATUSES.includes(where as TaskStatus) ? "info" : "warning"
    return { ok: false, kind: "message", message: where ? `"${id}" is in ${where} — nothing to do.` : `No task "${id}" found.`, variant }
  }
  const found: { id: string; from: TaskStatus }[] = []
  for (const from of folders) {
    for (const t of await listByStatus(client, directory, config.tasksDir, from, log)) found.push({ id: t.id, from })
  }
  if (found.length === 0) return { ok: false, kind: "none" }
  if (found.length === 1) return { ok: true, ...found[0]! }
  const list = found.map((f) => `${f.id} (${f.from})`).join(", ")
  return { ok: false, kind: "message", message: `Multiple tasks awaiting: ${list} — pass an id.`, variant: "warning" }
}

/**
 * approve shortcut — the unified, folder-driven gate. With an explicit `id` it
 * advances that task by the gate its folder implies: draft/ → queued (task gate),
 * plan-review/ → in-progress (plan gate), or in-review/ → completed (ship).
 * Without an id it advances the single task at a loop wait-gate (plan-review/ or
 * in-review/) — draft/ is deliberately excluded from auto-resolution.
 */
export const approveAny = async (ctx: GateCtx, id: string, kind = "engineering"): Promise<GateResult> => {
  const folders: readonly TaskStatus[] = id ? ["plan-review", "in-review", "draft"] : ["plan-review", "in-review"]
  const pick = await resolveGateTask(ctx, id, folders)
  if (!pick.ok) {
    return pick.kind === "none"
      ? { ok: false, message: "Nothing awaiting approval at a loop gate. (Approve a draft with /agentic-loop:engineering approve <id>.)", variant: "info" }
      : { ok: false, message: pick.message, variant: pick.variant }
  }
  if (pick.from === "draft") return approveTask(ctx, pick.id)
  if (pick.from === "plan-review") return approvePlan(ctx, pick.id)
  return shipTask(ctx, pick.id, kind) // in-review
}

/** ship shortcut: id optional — ships the single in-review/ task when omitted. */
export const shipAny = async (ctx: GateCtx, id: string, kind = "engineering"): Promise<GateResult> => {
  if (id) return shipTask(ctx, id, kind)
  const pick = await resolveGateTask(ctx, "", ["in-review"])
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
  const { $, directory, config } = ctx
  const [first = "", ...restParts] = arg.trim().split(/\s+/).filter(Boolean)
  if (first) {
    for (const from of ["plan-review", "in-progress"] as const) {
      if (await findByIdIn($, directory, config.tasksDir, from, first)) {
        return replanTask(ctx, first, restParts.join(" ").trim() || undefined)
      }
    }
  }
  const pick = await resolveGateTask(ctx, "", ["plan-review"])
  if (!pick.ok) {
    return pick.kind === "none" ? { ok: false, message: "No plan awaiting rejection.", variant: "info" } : { ok: false, message: pick.message, variant: pick.variant }
  }
  return replanTask(ctx, pick.id, arg.trim() || undefined)
}
