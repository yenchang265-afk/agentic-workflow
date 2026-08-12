import { createHash } from "node:crypto"
import { z } from "zod"
import {
  appendNote,
  auditNote,
  extractPlan,
  findByIdIn,
  hasPlan,
  joinTaskBody,
  rewriteTask,
  splitTaskBody,
  STATUSES,
} from "@agentic-workflow/core/task/store"
import { taskToInput, unknownFrontmatterKeys, type Task } from "@agentic-workflow/core/task/schema"
import { redact } from "@agentic-workflow/core/task/redact"
import { commitBacklog, oneLineReason, retaskTask } from "@agentic-workflow/core/workflow/gate"
import { gitActor } from "@agentic-workflow/core/workflow/git"
import type { TaskStatus } from "@agentic-workflow/core/task/statuses"
import type { SaveTaskRequest, SaveTaskResponse, TaskDetailResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { gateCtx } from "../gatectx.js"
import { badRequest, isSafeId, json, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { extractAuditNotes, missingNotes } from "../notes.js"
import { toCard } from "./backlog.js"
import { withGateLock } from "./gate.js"

/**
 * A single task: its detail view, and the in-place editor behind it.
 *
 * The hub has no authoring agent, so the CLI's `retask` — a folder move plus a
 * mandatory `interview-me` reshape — has no direct equivalent here. This route
 * is the honest one: the human types the reshape themselves, and a `queued/`
 * save performs the same approval-withdrawing move core's `retaskTask` does.
 * The edit goes through core's `rewriteTask`, the move through core's
 * `retaskTask`; the hub composes them, it does not re-implement either.
 *
 * Status codes, once:
 * - **400** — malformed request, or a status that is not editable at all.
 * - **409** — your view is stale; refetch (wrong folder, a plan appeared, the
 *   prose drifted, an audit note would be lost, unpreservable frontmatter).
 * - **200 `ok: false`** — a domain refusal (a loop is driving it, a secret in
 *   the body). Core models refusals as data, and the drawer renders them.
 * - **200 `ok: true`** — saved.
 */

/** Only a planless task in one of these folders may be edited in place. */
const EDITABLE_STATUSES: readonly TaskStatus[] = ["draft", "queued"]

/**
 * Line-free, so the value cannot break out of its YAML block-sequence entry
 * when `serializeTask` writes it back.
 */
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\n\r]*$/, "must be a single line")

const SaveTaskRequestSchema = z.object({
  expectStatus: z.enum(["draft", "queued"]),
  baseHash: z.string().min(1).max(128),
  title: line(200),
  type: line(40).optional(),
  priority: z.number().int().min(-1000).max(1000),
  labels: z.array(line(60)).max(20),
  acceptance: z.array(line(500)).max(30),
  // Comfortably under MAX_BODY_BYTES, and under the argv limit the shell write
  // ultimately passes it through.
  body: z.string().max(100_000),
  reason: z.string().trim().max(500).optional(),
})

/** Stable fingerprint of the prose a human started editing. */
const hashProse = (prose: string): string => createHash("sha256").update(prose, "utf8").digest("hex").slice(0, 32)

/** Whether a planless task in an editable folder may be edited. */
const editableParts = (task: Task, status: string) => {
  if (!EDITABLE_STATUSES.includes(status as TaskStatus) || hasPlan(task)) return null
  const parts = splitTaskBody(task.body)
  return { ...parts, hash: hashProse(parts.prose) }
}

export const getTaskDetail = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const status = req.params["status"] ?? ""
  const id = req.params["id"] ?? ""
  // Any status folder an enabled kind declares is addressable (core STATUSES
  // as the fallback when no manifest loaded).
  const known = new Set<string>([...deps.boards.flatMap((b) => b.statuses), ...STATUSES])
  if (!known.has(status)) return badRequest(`unknown status "${status}"`)
  // `id` becomes a path segment in `findByIdIn` — screen out traversal
  // (`..%2f..`) before it reaches the filesystem, like the runs/tokens routes.
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)
  const task = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, status, id, deps.log)
  if (!task) return notFound(`task ${id} in ${status}`)
  const editable = editableParts(task, status)
  const response: TaskDetailResponse = {
    card: toCard(task),
    status,
    body: task.body,
    plan: extractPlan(task),
    notes: extractAuditNotes(task.body),
    ...(editable ? { editable } : {}),
  }
  return ok(response)
}

/** The fields a human may change, and how to name them in the audit note. */
const changedFields = (task: Task, next: SaveTaskRequest, nextBody: string): string[] => {
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i])
  const changed: string[] = []
  if (task.title !== next.title) changed.push("title")
  if ((task.type ?? "") !== (next.type ?? "")) changed.push("type")
  if (task.priority !== next.priority) changed.push("priority")
  if (!same(task.labels, next.labels)) changed.push("labels")
  if (!same(task.acceptance, next.acceptance)) changed.push("acceptance")
  if (task.body !== nextBody) changed.push("body")
  return changed
}

/**
 * POST /api/tasks/:status/:id — rewrite a planless task in place, and (from
 * `queued/`) send it back to `draft/`.
 *
 * Everything runs inside the gate's own lock key, so a save can never interleave
 * with a concurrent approve/replan on the same repo. It is deliberately ONE
 * request: the rewrite and the retask must share a single lock hold, and a tab
 * that died between two requests would leave a state nobody asked for.
 *
 * The rewrite runs BEFORE the move — the retask relocates the file, so writing
 * first means writing to the path just confirmed under the lock. A retask that
 * succeeded before a failed rewrite would also have withdrawn the approval for
 * nothing.
 *
 * Caveat: `postDoctorFix` serializes on its own key, so a stale-claim release
 * can race this route's driving check. The failure direction is benign — a
 * refusal the human retries — but it is not serialized.
 */
export const postTaskSave = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const status = req.params["status"] ?? ""
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)
  if (!EDITABLE_STATUSES.includes(status as TaskStatus)) {
    return badRequest(
      `tasks in ${status} are not editable — only a planless task in ${EDITABLE_STATUSES.join(" or ")} can be reshaped in place`,
    )
  }
  const parsed = SaveTaskRequestSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; "))
  }
  const body = parsed.data as SaveTaskRequest
  if (body.expectStatus !== status) {
    return badRequest(`expectStatus "${body.expectStatus}" does not match the ${status} the request addressed`)
  }

  return withGateLock(deps.directory, async () => {
    const task = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, status, id, deps.log)
    if (!task) {
      return json(409, {
        error: `"${id}" is no longer in ${status} (or its frontmatter no longer parses) — the board was stale. It has been refreshed.`,
      })
    }
    // A live PLAN stage writes into `queued/<id>.md` while the folder stays
    // right, so `expectStatus` cannot see it. Rewriting would delete the
    // loop's own artifact.
    if (hasPlan(task)) {
      return json(409, { error: `"${id}" has a plan now — send it back with Replan instead of editing the goal under it.` })
    }
    const parts = splitTaskBody(task.body)
    if (hashProse(parts.prose) !== body.baseHash) {
      return json(409, { error: `"${id}" changed on disk while you were editing — reopen it and reapply your changes.` })
    }
    // zod strips frontmatter keys the schema does not know, so rewriting a file
    // that carries one would silently delete it. Refuse instead.
    const raw = await deps.sh`cat ${task.path}`.quiet().nothrow()
    const unknown = raw.exitCode === 0 ? unknownFrontmatterKeys(raw.stdout.toString()) : []
    if (unknown.length > 0) {
      return json(409, {
        error: `"${id}" carries frontmatter this editor cannot preserve (${unknown.join(", ")}) — edit the file directly instead.`,
      })
    }

    const ctx = await gateCtx(deps)
    // The oracle already folds the claim markers of every pool status into
    // `isDriving`, so this one check covers both a live stage and a crashed
    // run's leftover marker.
    if (ctx.isDriving?.(id)) {
      const refusal: SaveTaskResponse = {
        ok: false,
        message: `Task "${id}" is being driven by a live loop — stop it first, then edit.`,
        variant: "warning",
      }
      return ok(refusal)
    }
    // `writeTask` and `rewriteTask` do not redact (only notes/plans/run logs
    // do), so a pasted token would be committed. Refuse and name the pattern —
    // never silently rewrite text the human is looking at.
    const scan = redact(body.body)
    if (scan.hits.length > 0) {
      const refusal: SaveTaskResponse = {
        ok: false,
        message: `That body looks like it contains a secret (${scan.hits.map((h) => h.pattern).join(", ")}) — remove it before saving.`,
        variant: "warning",
      }
      return ok(refusal)
    }

    // The tail comes from the file just read, never from the client — a note
    // appended while the human was typing survives without them sending it.
    const nextBody = joinTaskBody(body.body, parts.tail)
    const lost = missingNotes(task.body, nextBody)
    if (lost.length > 0) {
      return json(409, { error: `that edit would delete an audit note (${lost[0]}) — reopen the task and keep it.` })
    }
    const changed = changedFields(task, body, nextBody)
    if (changed.length === 0) {
      const unchanged: SaveTaskResponse = {
        ok: true,
        message: `"${task.title}" is unchanged — nothing written.`,
        path: task.path,
        changed: [],
      }
      return ok(unchanged)
    }

    let path: string
    try {
      path = await rewriteTask(deps.sh, task, {
        ...taskToInput(task),
        title: body.title,
        type: body.type,
        priority: body.priority,
        labels: body.labels,
        acceptance: body.acceptance,
        body: nextBody,
      }, deps.log)
    } catch (err) {
      return badRequest(`could not save "${id}": ${(err as Error).message}`)
    }

    const actor = await gitActor(deps.sh, deps.directory)
    // Through core's choke point, not `body.reason` raw: the reason comes from a
    // <textarea>, and `z.string().trim()` leaves interior newlines alone — an
    // audit note is one line closed by a stamp, so a pasted paragraph breaks the
    // shape every note parser and the audit-tail boundary depend on.
    const reason = oneLineReason(body.reason)
    const why = reason ? ` — ${reason}` : ""
    await appendNote(
      deps.sh,
      { id: task.id, path },
      auditNote(`Task edited in the hub (${changed.join(", ")})${why}`, new Date(), actor),
      deps.log,
    )

    if (status !== "queued") {
      await commitBacklog(deps.sh, deps.directory, deps.config, `loop(${id}): task edited in the hub`)
      const saved: SaveTaskResponse = {
        ok: true,
        message: `Saved "${body.title}" — ${changed.join(", ")} updated.`,
        path,
        changed,
      }
      return ok(saved)
    }

    // A queued task's approval was taken against the OLD goal, so reshaping it
    // withdraws that approval. retaskTask appends its own note, moves the file,
    // and commits — which stages the rewrite above in the same commit.
    const retask = await retaskTask(ctx, id, body.reason)
    if (!retask.ok) {
      // The edit landed and the task simply stayed in queued/ — coherent, not
      // corrupt. Commit it so it is not left hanging in the working tree.
      await commitBacklog(deps.sh, deps.directory, deps.config, `loop(${id}): task edited in the hub`)
    }
    const saved: SaveTaskResponse = {
      ok: true,
      message: retask.ok
        ? `Saved "${body.title}" and sent it back to draft/ — approve it again once it looks right.`
        : `Saved "${body.title}", but it stayed in queued/: ${retask.message}`,
      path: retask.ok ? retask.path : path,
      changed,
      retask,
    }
    return ok(saved)
  })
}
