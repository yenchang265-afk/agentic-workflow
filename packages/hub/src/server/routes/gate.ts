import { approvePlan, approveTask, removeTask, replanTask, shipTask, type GateCtx, type GateResult } from "@agentic-workflow/core/workflow/gate"
import { findByIdIn, STATUSES } from "@agentic-workflow/core/task/store"
import type { TaskStatus } from "@agentic-workflow/core/task/statuses"
import type { GateAction, GateRequest } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { gateCtx } from "../gatectx.js"
import { badRequest, isSafeId, json, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { withLock } from "../lock.js"

/**
 * The human gate moves, from a browser click. This is the hub's first real
 * write: it moves task files and writes git commits, and `ship` opens a pull
 * request. It performs those moves through the *same* core entry points both
 * hosts use (`workflow/gate.ts`) rather than re-implementing them — the hub is a
 * fourth caller of the gate, not a fourth driver. It never claims work and never
 * runs a stage.
 */

/**
 * Each action maps 1:1 onto an explicit core op, and declares the status its
 * task must be in.
 *
 * Deliberately not core's `approveAny` / `rejectAny` shortcuts: those exist to
 * resolve ambiguity from a CLI where the human typed no id, inferring the gate
 * from whichever folder the task happens to sit in. A hub button lives on a
 * specific card in a specific column — there is no ambiguity to resolve, and
 * letting a race pick the gate could perform a *different* move than the button
 * said.
 */
const ACTIONS: Readonly<Record<GateAction, { from: TaskStatus; run: (ctx: GateCtx, id: string, body: GateRequest) => Promise<GateResult> }>> = {
  "approve-task": { from: "draft", run: (ctx, id) => approveTask(ctx, id) },
  "approve-plan": { from: "plan-review", run: (ctx, id) => approvePlan(ctx, id) },
  replan: { from: "plan-review", run: (ctx, id, body) => replanTask(ctx, id, body.reason?.trim() || undefined) },
  ship: { from: "in-review", run: (ctx, id, body) => shipTask(ctx, id, body.kind ?? "engineering") },
  // remove hard-deletes the task; its button lives on every column, so it has
  // no single origin — `from` is nominal and every status is a valid origin
  // (see `allowedFrom`). Core refuses a live-driven or claim-held task.
  remove: { from: "draft", run: (ctx, id) => removeTask(ctx, id) },
}

/** `replan` also accepts a cap-tripped in-progress task — the only forward action with two valid origins. */
const EXTRA_FROM: Partial<Record<GateAction, readonly TaskStatus[]>> = { replan: ["in-progress"] }

/** The statuses an action may run from: every folder for `remove`, else its declared origins. */
const allowedFrom = (action: GateAction): readonly TaskStatus[] =>
  action === "remove" ? STATUSES : [ACTIONS[action].from, ...(EXTRA_FROM[action] ?? [])]

const isGateAction = (s: string): s is GateAction => Object.hasOwn(ACTIONS, s)

/**
 * Serialize gate moves per repo: two concurrent POSTs (double-click, two tabs)
 * both passing the stale-board check before either moves is a TOCTOU — the
 * second would act on a board state the first just invalidated. The shared
 * `withLock` chain makes confirm+move atomic across THIS hub's requests;
 * the race against the loop (a separate process) stays closed by core's own
 * guards (`moveTask` refuses when the file left its folder). Exported for tests.
 */
export const withGateLock = <T>(dir: string, fn: () => Promise<T>): Promise<T> => withLock(`gate:${dir}`, fn)

const statusOf = async (deps: HubDeps, id: string): Promise<TaskStatus | null> => {
  for (const s of STATUSES) {
    if (await findByIdIn(deps.sh, deps.directory, deps.tasksDir, s, id)) return s
  }
  return null
}

/**
 * POST /api/gate/:action — body `{ id, expectStatus, reason?, kind? }`.
 *
 * Returns **200 for every well-formed request**, carrying core's `GateResult`
 * verbatim. `ok: false` is a domain refusal ("it's in queued, not draft"), not a
 * transport error, and the browser's `parse()` throws on `!res.ok` — a 4xx would
 * collapse the refusal into an `Error` and lose `variant`, the info-vs-warning
 * distinction core deliberately models. 400 is reserved for a malformed request,
 * 409 for a stale board.
 */
export const postGate = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const action = req.params["action"] ?? ""
  if (!isGateAction(action)) return badRequest(`unknown gate action "${action}" — expected ${Object.keys(ACTIONS).join(", ")}`)

  const body = (req.body ?? {}) as Partial<GateRequest>
  const id = body.id ?? ""
  // `id` reaches the filesystem as a path segment via findByIdIn — screen out
  // traversal before it gets there, exactly as the backlog/runs routes do.
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)

  const spec = ACTIONS[action]
  const allowed = allowedFrom(action)
  const expectStatus = body.expectStatus
  if (!expectStatus || !allowed.includes(expectStatus)) {
    return badRequest(`${action} needs expectStatus to be one of ${allowed.join(", ")}`)
  }

  /*
   * The board is SSE-driven and can lag: a card can still show `in-review` after
   * the loop moved the task on. Without this check a click on a stale board
   * performs a gate the human did not actually see — shipping a task that had
   * already moved. One `cat` to confirm the task is still where the client
   * thought, before anything commits — inside the per-repo lock, so a second
   * concurrent request re-checks AFTER the first one's move, not beside it.
   */
  return withGateLock(deps.directory, async () => {
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
    const result = await spec.run(ctx, id, body as GateRequest)
    return ok(result)
  })
}
