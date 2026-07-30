import { requestPlan, revokePlanRequest } from "@agentic-workflow/core/task/plan-request"
import { findByIdIn, hasPlan } from "@agentic-workflow/core/task/store"
import { gitActor } from "@agentic-workflow/core/workflow/git"
import type { GateResult } from "@agentic-workflow/core/workflow/gate"
import type { PlanRequestRequest } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { makeDrivingOracle } from "../driving.js"
import { badRequest, isSafeId, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { staleBoard, withGateLock } from "./gate.js"

/**
 * `POST /api/plan-request` and `/api/plan-request/cancel` — the Plan button on a
 * `queued/` card.
 *
 * This is the one hub write that moves nothing and commits nothing. It drops a
 * marker in `queued/.requests/` saying "plan this one next"; the next `claim` or
 * `watch` tick reads it, plans that task ahead of the rest of the queued pool,
 * and spends the marker. **The hub still never claims work and never runs a
 * stage** — it writes an ordering hint and a driver, in its own process, decides
 * what to do with it.
 *
 * Kept off `/api/gate/:action` for that reason: every entry in that table maps
 * 1:1 onto a core op that moves a task file and writes a git commit, and its
 * tests assert the commit. Adding a non-committing, non-moving action there
 * would make `GateAction`, `allowedFrom` and both docstrings false.
 *
 * Answers with core's `GateResult` regardless, so `postAction`, `gateTone` and
 * `<StatusMessage>` render a refusal here exactly as they do for a gate move:
 * 200 for every well-formed request, 400 for a malformed one, 409 for a stale
 * board.
 */

/** The only column a plan request can be made from — the planless pool. */
const FROM = "queued"

const parse = (req: ParsedRequest): { error: JsonResponse } | { id: string } => {
  const body = (req.body ?? {}) as Partial<PlanRequestRequest>
  const id = body.id ?? ""
  // `id` becomes a path segment in the marker directory — screen out traversal
  // before it gets there, exactly as the gate route does. (Core screens it
  // again; this is the boundary check, not the only one.)
  if (!isSafeId(id)) return { error: badRequest(`invalid task id "${id}"`) }
  if (body.expectStatus !== FROM) return { error: badRequest(`plan-request needs expectStatus to be ${FROM}`) }
  return { id }
}

/**
 * Ask for `id` to be planned next.
 *
 * Runs under the gate's own lock key, so a request can never interleave with a
 * concurrent approve/replan on the same repo — the same reason the task-save
 * route shares it.
 */
export const postPlanRequest = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const parsed = parse(req)
  if ("error" in parsed) return parsed.error
  const { id } = parsed

  return withGateLock(deps.directory, async () => {
    const here = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, FROM, id, deps.log)
    if (!here) return staleBoard(deps, id, FROM)

    // A queued task that already carries a plan is one `replan` sent back
    // without clearing it. Planning it again would append a SECOND
    // `## Implementation Plan`, and extractPlan reads the last — so the older
    // one silently stops existing. Point at the gate that actually applies.
    if (hasPlan(here)) {
      return ok({
        ok: false,
        variant: "warning",
        message: `"${id}" already carries a plan — approve it, or send it back with Replan to have it rewritten.`,
      } satisfies GateResult)
    }

    // Requesting a plan for a task a loop is already planning is a no-op the
    // user would read as "it worked". Say so instead.
    const oracle = await makeDrivingOracle(deps)
    if (oracle.isDriving(id)) {
      return ok({
        ok: false,
        variant: "info",
        message: `"${id}" is being driven right now — there is nothing to request.`,
      } satisfies GateResult)
    }

    const by = await gitActor(deps.sh, deps.directory)
    if (!(await requestPlan(deps.sh, deps.directory, deps.tasksDir, id, { by }))) {
      return ok({
        ok: false,
        variant: "warning",
        message: `Could not write the plan request for "${id}" — check that ${deps.tasksDir}/${FROM}/ is writable.`,
      } satisfies GateResult)
    }
    return ok({
      ok: true,
      path: here.path,
      data: {},
      message: `Plan requested for "${here.title}" — the next claim or watch tick plans it before other queued tasks. Nothing runs until then.`,
    } satisfies GateResult)
  })
}

/**
 * Withdraw a plan request. Idempotent, and refuses nothing a request would:
 * you must always be able to take back an ask, including one a loop has since
 * started acting on.
 */
export const postPlanRequestCancel = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const parsed = parse(req)
  if ("error" in parsed) return parsed.error
  const { id } = parsed

  return withGateLock(deps.directory, async () => {
    const removed = await revokePlanRequest(deps.sh, deps.directory, deps.tasksDir, id)
    return ok({
      ok: true,
      path: "",
      data: { removed },
      ...(removed ? {} : { variant: "info" as const }),
      message: removed
        ? `Plan request withdrawn for "${id}". It stays in ${FROM}/ and is planned in the normal order.`
        : `No plan request was outstanding for "${id}" — nothing to withdraw.`,
    } satisfies GateResult)
  })
}
