import { deleteTask, surveyDeletion } from "@agentic-loop/core/loop/delete"
import { findByIdIn, STATUSES } from "@agentic-loop/core/task/store"
import type { TaskStatus } from "@agentic-loop/core/task/statuses"
import type { DeletePreview, DeleteRequest } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { gateCtx } from "../gatectx.js"
import { badRequest, isSafeId, json, ok, type JsonResponse, type ParsedRequest } from "../http.js"

/**
 * Task deletion from a browser click — the hub's only destructive action.
 *
 * Like the gate routes, this calls the shared core entry point
 * (`loop/delete.ts`) rather than re-implementing the removal, so the browser
 * gets exactly the refusals the two CLI hosts get. It adds one thing the CLIs
 * don't need: a **preview** endpoint, so the confirm dialog can state what
 * would be destroyed before the human commits to it — the same information the
 * CLI conveys by refusing once and making you re-type `force`.
 */

const statusOf = async (deps: HubDeps, id: string): Promise<TaskStatus | null> => {
  for (const s of STATUSES) {
    if (await findByIdIn(deps.sh, deps.directory, deps.tasksDir, s, id)) return s
  }
  return null
}

/**
 * GET /api/tasks/:status/:id/delete-preview — read-only. Powers the confirm
 * dialog: what has a worktree, what has unmerged commits, which child slices a
 * tracking epic would take with it.
 */
export const getDeletePreview = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)

  const ctx = await gateCtx(deps)
  const result = await surveyDeletion(ctx, id)
  if ("error" in result) return json(404, { error: result.error.message })

  const s = result.survey
  const preview: DeletePreview = {
    id: s.id,
    title: s.title,
    status: s.status,
    worktree: s.worktree,
    worktreeDirty: s.worktreeDirty,
    branch: s.branch,
    branchExists: s.branchExists,
    unmergedCommits: s.unmergedCommits,
    isEpic: s.isEpic,
    children: s.children.map((c) => ({ id: c.id, title: c.title, status: c.status })),
    blockers: s.blockers,
    isDriving: ctx.isDriving?.(s.id) === true,
  }
  return ok(preview)
}

/**
 * POST /api/tasks/:status/:id/delete — body `{ id, expectStatus, force? }`.
 *
 * Same envelope discipline as `postGate`: **200 for every well-formed request**,
 * carrying core's `GateResult` verbatim, because `ok: false` here is a designed
 * refusal (dirty worktree, unmerged commits, an unforced epic) rather than a
 * transport error — and the browser's `parse()` throws on `!res.ok`, which would
 * collapse the refusal and lose its message. 400 is a malformed request, 409 a
 * stale board.
 */
export const postDelete = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = (req.body ?? {}) as Partial<DeleteRequest>
  const id = body.id ?? ""
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)
  // The id appears in both the path and the body. They must agree — a mismatch
  // means the client built the request wrong, and silently trusting one of them
  // for an irreversible op is how the wrong task gets deleted.
  const pathId = req.params["id"] ?? ""
  if (pathId !== id) return badRequest(`task id mismatch: "${pathId}" in the path, "${id}" in the body`)

  const expectStatus = body.expectStatus
  if (!expectStatus || !STATUSES.includes(expectStatus)) {
    return badRequest(`delete needs expectStatus to be one of ${STATUSES.join(", ")}`)
  }

  // The board is SSE-driven and can lag. Deleting from a stale card would
  // destroy a task whose real state the human never saw — the one place that
  // matters most, since there is no undo.
  const here = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, expectStatus, id, deps.log)
  if (!here) {
    const actual = await statusOf(deps, id)
    return json(409, {
      error: actual
        ? `"${id}" is in ${actual}, not ${expectStatus} — the board was stale. It has been refreshed.`
        : `"${id}" is no longer in ${expectStatus} — the board was stale. It has been refreshed.`,
      ...(actual ? { actual } : {}),
    })
  }

  const ctx = await gateCtx(deps)
  return ok(await deleteTask(ctx, id, { force: body.force === true }))
}
