import {
  findByIdIn,
  hasPlan,
  extractPlan,
  listByStatus,
  listClaimIds,
  summarizeBacklog,
  STATUSES,
  type TaskStatus,
} from "@agentic-loop/core/task/store"
import { isPaired, type Task } from "@agentic-loop/core/task/schema"
import { auditBacklog, hasAnomalies } from "@agentic-loop/core/task/audit"
import type { BacklogResponse, KindBoardInfo, TaskCard, TaskDetailResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { badRequest, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { extractAuditNotes } from "../notes.js"

/**
 * Read-only backlog views: the per-kind board roll-up and single-task detail.
 * Board shape (columns, gate highlights, claim pools) comes from the kind's
 * manifest via `deps.boards` — only the engineering kind gets the lifecycle
 * summary and audit sweep, which are engineering-shaped by construction.
 */

const toCard = (task: Task): TaskCard => ({
  id: task.id,
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
  if (!board) return notFound(`no enabled loop kind "${kind}"`)
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

  // The lifecycle summary + audit sweep read the engineering folder shape.
  const engineering = kind === "engineering"
  const summary = engineering
    ? summarizeBacklog(tasks as Readonly<Record<TaskStatus, readonly Task[]>>, claimedIds)
    : null
  const anomalies = engineering ? await auditBacklog(deps.client, deps.directory, deps.tasksDir) : null

  const response: BacklogResponse = {
    kind,
    statuses: board.statuses,
    gateStatuses: board.gateStatuses,
    tasks: cards,
    summary,
    claimedIds,
    anomalies: anomalies && hasAnomalies(anomalies) ? anomalies : null,
  }
  return ok(response)
}

export const getTaskDetail = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const status = req.params["status"] ?? ""
  const id = req.params["id"] ?? ""
  // Any status folder an enabled kind declares is addressable (core STATUSES
  // as the fallback when no manifest loaded).
  const known = new Set<string>([...deps.boards.flatMap((b) => b.statuses), ...STATUSES])
  if (!known.has(status)) return badRequest(`unknown status "${status}"`)
  const task = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, status, id, deps.log)
  if (!task) return notFound(`task ${id} in ${status}`)
  const response: TaskDetailResponse = {
    card: toCard(task),
    status,
    body: task.body,
    plan: extractPlan(task),
    notes: extractAuditNotes(task.body),
  }
  return ok(response)
}
