import { z } from "zod"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import { parseRunMetrics, type RunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import type {
  LiveProgress,
  RunDetailResponse,
  RunListItem,
  RunsResponse,
  SnapshotView,
  StageActivity,
  TimelineSpan,
} from "../../shared/api.js"
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
  // The bounded per-iteration verdict ledger (core's AttemptRecord) — the
  // failure forensics trail. Malformed elements drop individually rather than
  // taking the whole snapshot view down with them.
  attempts: z
    .array(
      z.object({
        stage: z.string(),
        iteration: z.number().int(),
        verdict: z.string(),
        reason: z.string().optional(),
      }),
    )
    .optional()
    .catch(undefined),
  isolationWarning: z.string().optional(),
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
const readSidecar = async (deps: HubDeps, id: string): Promise<RunMetrics | null> => {
  const raw = await readText(deps, `${deps.tasksDir}/runs/${id}.metrics.json`)
  return raw === null ? null : parseRunMetrics(raw)
}

const toActivity = (sidecar: RunMetrics): readonly StageActivity[] => {
  const activity: StageActivity[] = []
  for (const entry of sidecar.runs) {
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

/**
 * Stage spans for the run timeline: every sample with a recorded start. Samples
 * without one are counted (`excluded`), never silently dropped — an old sidecar
 * must read as "partially measured", not "this run was fast".
 */
const toTimeline = (sidecar: RunMetrics): { spans: readonly TimelineSpan[]; excluded: number } => {
  const spans: TimelineSpan[] = []
  let excluded = 0
  for (const entry of sidecar.runs) {
    for (const s of entry.samples) {
      if (!s.startedAt) {
        excluded++
        continue
      }
      spans.push({
        stage: s.stage,
        ...(s.lens ? { lens: s.lens } : {}),
        iteration: s.iteration + 1,
        startedAt: s.startedAt,
        ms: s.ms,
        ...(s.model ? { model: s.model } : {}),
        ...(entry.open ? { live: true } : {}),
      })
    }
  }
  spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return { spans, excluded }
}

/** The live progress strip's data: the trailing entry is `open` and its last sample names the current stage. */
const toLive = (sidecar: RunMetrics): LiveProgress | undefined => {
  const last = sidecar.runs[sidecar.runs.length - 1]
  if (!last?.open) return undefined
  const s = last.samples[last.samples.length - 1]
  if (!s) return undefined
  return {
    stage: s.stage,
    ...(s.lens ? { lens: s.lens } : {}),
    iteration: s.iteration + 1,
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    host: last.host,
  }
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
      ...(s.attempts?.length ? { attempts: s.attempts } : {}),
      ...(s.isolationWarning ? { isolationWarning: s.isolationWarning } : {}),
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
  const sidecar = await readSidecar(deps, id)
  const activity = sidecar ? toActivity(sidecar) : []
  const timeline = sidecar ? toTimeline(sidecar) : { spans: [], excluded: 0 }
  const live = sidecar ? toLive(sidecar) : undefined
  const response: RunDetailResponse = {
    id,
    log: parseRunLog(content),
    snapshot: await readSnapshot(deps, id),
    ...(activity.length ? { activity } : {}),
    ...(timeline.spans.length ? { timeline: timeline.spans } : {}),
    ...(timeline.excluded > 0 ? { timelineExcluded: timeline.excluded } : {}),
    ...(live ? { live } : {}),
  }
  return ok(response)
}
