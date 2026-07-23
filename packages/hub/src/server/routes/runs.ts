import { z } from "zod"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import { parseRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import type { RunDetailResponse, RunListItem, RunsResponse, SnapshotView, StageActivity } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { readStageMarker } from "../driving.js"
import { mapBounded, readText } from "../io.js"
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
  // Keys only: which stages a resume would see captured output for. The
  // bodies duplicate the run log's stage sections, so they stay there.
  artifacts: z.record(z.string(), z.string()).optional(),
})

const readRunLog = (deps: HubDeps, id: string): Promise<string | null> => readText(deps, `${deps.tasksDir}/runs/${id}.md`)

/**
 * Per-stage tool/file activity from the metrics sidecar, keyed to match the
 * run-log section headers (iteration rendered 1-based, as `runlog` writes it).
 * Only samples that actually carry tool activity produce a row — a run whose
 * host observed no tool parts (or that predates capture) yields none, so the
 * UI simply shows no activity chips. Unreadable sidecar → no activity, never an
 * error (parity with `readSnapshot`).
 */
const readActivity = async (deps: HubDeps, id: string): Promise<readonly StageActivity[]> => {
  const raw = await readText(deps, `${deps.tasksDir}/runs/${id}.metrics.json`)
  if (raw === null) return []
  const parsed = parseRunMetrics(raw)
  if (!parsed) return []
  const activity: StageActivity[] = []
  for (const entry of parsed.runs) {
    for (const s of entry.samples) {
      if (!s.tools?.length && !s.files?.length) continue
      activity.push({
        stage: s.stage,
        ...(s.lens ? { lens: s.lens } : {}),
        iteration: s.iteration + 1,
        tools: s.tools ?? [],
        ...(s.files?.length ? { files: s.files } : {}),
      })
    }
  }
  return activity
}

const readSnapshot = async (deps: HubDeps, id: string): Promise<SnapshotView | null> => {
  const content = await readText(deps, `${deps.tasksDir}/runs/${id}.state.json`)
  if (!content) return null
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const s = parsed.data
    const artifactStages = Object.keys(s.artifacts ?? {})
    return {
      ...(s.kind ? { kind: s.kind } : {}),
      goal: s.goal,
      stage: s.stage,
      iteration: s.iteration,
      ...(s.task?.id ? { taskId: s.task.id } : {}),
      ...(s.git?.branch ? { branch: s.git.branch } : {}),
      ...(s.git?.worktree ? { worktree: s.git.worktree } : {}),
      ...(artifactStages.length ? { artifactStages } : {}),
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
  // The one parser of the live stage markers (either host's) lives in
  // driving.ts; this route only wants the task id it names (null covers: no
  // live loop, an unreadable marker). Display only, same spirit as
  // `readSnapshot`.
  const activeTaskId = (await readStageMarker(deps))?.taskId ?? null
  const runs: RunListItem[] = (
    await mapBounded(ids, 16, async (id): Promise<RunListItem[]> => {
      const content = await readRunLog(deps, id)
      if (content === null) return []
      const { summaries } = parseRunLog(content)
      const latest = summaries[summaries.length - 1]
      return [
        {
          id,
          ...(latest ? { outcome: latest.outcome, at: latest.at } : {}),
          ...(latest?.detail ? { detail: latest.detail } : {}),
          runs: summaries.length,
          // A run whose task is currently being driven is live — the last summary
          // (e.g. the plan pass's "done") describes a PRIOR pass, not this one.
          ...(id === activeTaskId ? { active: true } : {}),
        },
      ]
    })
  ).flat()
  runs.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
  const response: RunsResponse = { runs }
  return ok(response)
}

export const getRunDetail = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return notFound(`run ${id}`)
  const content = await readRunLog(deps, id)
  if (content === null) return notFound(`run ${id}`)
  const activity = await readActivity(deps, id)
  const response: RunDetailResponse = {
    id,
    log: parseRunLog(content),
    snapshot: await readSnapshot(deps, id),
    ...(activity.length ? { activity } : {}),
  }
  return ok(response)
}
