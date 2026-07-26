import {
  hasPlan,
  listByStatus,
  listClaimIds,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-workflow/core/task/store"
import { isPaired, shortIdOf, type Task } from "@agentic-workflow/core/task/schema"
import { auditBacklog, hasAnomalies } from "@agentic-workflow/core/task/audit"
import type { BacklogResponse, KindBoardInfo, TaskCard } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { auditStatuses } from "../kindboard.js"
import { badRequest, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"

/**
 * The read-only backlog board: the per-kind roll-up. Board shape (columns, gate
 * highlights, claim pools) comes from the kind's manifest via `deps.boards`. The
 * audit sweep runs for every backlog kind (it reads the shared backlog root,
 * judged against every enabled kind's status set); only the lifecycle summary
 * stays engineering-only — its semantics ("interrupted", plan-gate counts) are
 * engineering's by construction.
 *
 * Single-task detail (and its editor) lives in `tasks.ts` — that route writes,
 * and this file stays a read-only view.
 */

/** Shared with `tasks.ts`, so a card on the board and a card in the drawer can never disagree. */
export const toCard = (task: Task): TaskCard => ({
  id: task.id,
  shortId: shortIdOf(task.id),
  title: task.title,
  type: task.type,
  priority: task.priority,
  labels: task.labels,
  acceptance: task.acceptance,
  paired: isPaired(task),
  hasPlan: hasPlan(task),
})

const boardFor = (deps: HubDeps, kind: string): KindBoardInfo | undefined =>
  deps.boards.find((b) => b.kind === kind)

export const getBacklog = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const kind = req.query.get("kind") ?? "engineering"
  const board = boardFor(deps, kind)
  if (!board) return notFound(`no enabled workflow kind "${kind}"`)
  if (board.sourceType !== "backlog") return badRequest(`kind "${kind}" has no backlog board (${board.sourceType})`)

  const tasks: Record<string, readonly Task[]> = {}
  for (const status of board.statuses) {
    tasks[status] = await listByStatus(deps.client, deps.directory, deps.tasksDir, status, deps.log)
  }
  const claimedIds = (
    await Promise.all(board.pools.map((status) => listClaimIds(deps.sh, deps.directory, deps.tasksDir, status)))
  ).flat()
  const cards: Record<string, readonly TaskCard[]> = {}
  for (const status of board.statuses) cards[status] = (tasks[status] ?? []).map(toCard)

  // The lifecycle summary reads the engineering folder shape; the audit is
  // backlog-root-wide and runs for every backlog kind.
  const summary =
    kind === "engineering"
      ? summarizeBacklog(tasks as Readonly<Record<TaskStatus, readonly Task[]>>, claimedIds)
      : null
  const anomalies = await auditBacklog(deps.client, deps.directory, deps.tasksDir, auditStatuses(deps.boards))

  const response: BacklogResponse = {
    kind,
    statuses: board.statuses,
    gateStatuses: board.gateStatuses,
    tasks: cards,
    summary,
    claimedIds,
    anomalies: hasAnomalies(anomalies) ? anomalies : null,
  }
  return ok(response)
}

