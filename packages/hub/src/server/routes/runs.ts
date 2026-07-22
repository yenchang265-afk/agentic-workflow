import { z } from "zod"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { RunDetailResponse, RunListItem, RunsResponse, SnapshotView } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { isSafeId, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"

/** Run history: the durable `runs/<id>.md` logs plus display-only snapshot views. */

/**
 * Snapshots are parsed permissively for DISPLAY — unlike core's `loadState`,
 * which fails closed on stages a crashed loop must not resume at. The monitor
 * wants to show whatever is on disk, not decide resumability.
 */
const SnapshotSchema = z.object({
  kind: z.string().optional(),
  goal: z.string().default(""),
  stage: z.string().default("?"),
  iteration: z.number().int().default(0),
  task: z.object({ id: z.string() }).partial().optional(),
  git: z.object({ branch: z.string().optional(), worktree: z.string().optional() }).optional(),
})

/**
 * The task id of the loop driving a stage RIGHT NOW, from the Claude host's
 * live `runs/.stage.json` marker, or null (no live loop, opencode host, or an
 * unreadable/task-less marker). Parsed permissively — display only, same spirit
 * as `readSnapshot`. Only `taskId` is needed here, so the rest is ignored.
 */
const readActiveTaskId = async (deps: HubDeps): Promise<string | null> => {
  const read = await deps.client.file
    .read({ query: { path: `${deps.tasksDir}/runs/.stage.json`, directory: deps.directory } })
    .catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    const parsed = z.object({ taskId: z.string().nullable().optional() }).safeParse(JSON.parse(content))
    return parsed.success ? (parsed.data.taskId ?? null) : null
  } catch {
    return null
  }
}

const readRunLog = async (deps: HubDeps, id: string): Promise<string | null> => {
  const read = await deps.client.file
    .read({ query: { path: `${deps.tasksDir}/runs/${id}.md`, directory: deps.directory } })
    .catch(() => null)
  return read?.data?.content ?? null
}

const readSnapshot = async (deps: HubDeps, id: string): Promise<SnapshotView | null> => {
  const read = await deps.client.file
    .read({ query: { path: `${deps.tasksDir}/runs/${id}.state.json`, directory: deps.directory } })
    .catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const s = parsed.data
    return {
      ...(s.kind ? { kind: s.kind } : {}),
      goal: s.goal,
      stage: s.stage,
      iteration: s.iteration,
      ...(s.task?.id ? { taskId: s.task.id } : {}),
      ...(s.git?.branch ? { branch: s.git.branch } : {}),
      ...(s.git?.worktree ? { worktree: s.git.worktree } : {}),
    }
  } catch {
    return null
  }
}

export const getRuns = async (deps: HubDeps): Promise<JsonResponse> => {
  const listed = await deps.client.file
    .list({ query: { path: `${deps.tasksDir}/runs`, directory: deps.directory } })
    .catch(() => null)
  const ids = (listed?.data ?? [])
    .filter((n) => n.type === "file" && n.name.endsWith(".md"))
    .map((n) => n.name.replace(/\.md$/, ""))
  const activeTaskId = await readActiveTaskId(deps)
  const runs: RunListItem[] = []
  for (const id of ids) {
    const content = await readRunLog(deps, id)
    if (content === null) continue
    const { summaries } = parseRunLog(content)
    const latest = summaries[summaries.length - 1]
    runs.push({
      id,
      ...(latest ? { outcome: latest.outcome, at: latest.at } : {}),
      ...(latest?.detail ? { detail: latest.detail } : {}),
      runs: summaries.length,
      // A run whose task is currently being driven is live — the last summary
      // (e.g. the plan pass's "done") describes a PRIOR pass, not this one.
      ...(id === activeTaskId ? { active: true } : {}),
    })
  }
  runs.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
  const response: RunsResponse = { runs }
  return ok(response)
}

export const getRunDetail = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return notFound(`run ${id}`)
  const content = await readRunLog(deps, id)
  if (content === null) return notFound(`run ${id}`)
  const response: RunDetailResponse = {
    id,
    log: parseRunLog(content),
    snapshot: await readSnapshot(deps, id),
  }
  return ok(response)
}
