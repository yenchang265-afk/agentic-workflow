import { z } from "zod"
import { isLeaseStale, readLeaseOwner, staleThresholdMs } from "@agentic-loop/core/scheduler/lease"
import { listClaimIds } from "@agentic-loop/core/task/store"
import type { StageMarker } from "../shared/api.js"
import type { HubDeps } from "./deps.js"

/**
 * "Is something already driving this task?" — the question every hub write must
 * answer before it moves a task file. Core's gate takes it as `GateCtx.isDriving`
 * and refuses a replan when it says yes (see `loop/gate.ts`); the OpenCode host
 * answers from its in-memory session map, the Claude host from its active loop.
 * The hub has neither, so it reads the same filesystem substrate the hosts write.
 *
 * Two signals, in order of strength:
 *
 * 1. **Claim markers** — the load-bearing one. A loop claims a task (an atomic
 *    `mkdir` under `<status>/.claims/`) *before* it starts driving it and holds
 *    the claim throughout, so **driving implies claimed**. That makes claims a
 *    per-task signal, unlike the lease.
 * 2. **The stage marker** (`runs/.stage.json`) — written by the Claude host while
 *    a stage runs, and it names the task. The OpenCode host writes none.
 *
 * The watch lease is deliberately **not** a driving signal: a live watcher that
 * holds no claim is polling, not driving, and blocking on it would refuse every
 * gate move for as long as a watcher runs — which is the normal workflow. It is
 * reported as `watcherLive` for context only.
 *
 * The bias is deliberate: a stranded claim causes a spurious refusal, which is a
 * recoverable annoyance the doctor clears. A false "not driving" re-queues a task
 * mid-BUILD and destroys work. **When unsure, say driving.**
 */

const StageMarkerSchema = z.object({
  kind: z.string().optional(),
  stage: z.string(),
  taskId: z.string().nullable().optional(),
  worktree: z.string().nullable().optional(),
  deadline: z.number().nullable().optional(),
})

/**
 * The stage marker on disk, or null when absent/garbled. The single reader —
 * `routes/active.ts` renders the same marker and imports this rather than
 * keeping a second parser that could drift.
 */
export const readStageMarker = async (deps: HubDeps): Promise<StageMarker | null> => {
  const read = await deps.client.file
    .read({ query: { path: `${deps.tasksDir}/runs/.stage.json`, directory: deps.directory } })
    .catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    const parsed = StageMarkerSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface DrivingOracle {
  /** Whether a loop is driving `id` right now: it holds a claim, or the stage marker names it. */
  readonly isDriving: (id: string) => boolean
  /** The task the stage marker names, if any. Null when no marker is on disk or it names no task. */
  readonly markerTaskId: string | null
  /** Every task holding a claim marker, across every pool any enabled kind declares. */
  readonly claimedIds: readonly string[]
  /** Whether a non-stale watch lease exists (an OpenCode watcher is alive). Context, not a blocker. */
  readonly watcherLive: boolean
  /** The live watcher's pid, for refusal messages that name what to stop. Null when no live lease. */
  readonly leasePid: number | null
}

/**
 * Read the driving signals once and return a synchronous oracle over them — a
 * route answers many ids against one filesystem read rather than re-scanning per
 * task. `now` is injected so the lease staleness check is testable.
 */
export const makeDrivingOracle = async (deps: HubDeps, now: Date = new Date()): Promise<DrivingOracle> => {
  const marker = await readStageMarker(deps)
  const pools = [...new Set(deps.boards.flatMap((b) => b.pools))]
  const claimed = new Set(
    (await Promise.all(pools.map((status) => listClaimIds(deps.sh, deps.directory, deps.tasksDir, status)))).flat(),
  )
  const owner = await readLeaseOwner(deps.sh, deps.directory, deps.tasksDir)
  const watcherLive = owner !== null && !isLeaseStale(owner, now, staleThresholdMs(owner.intervalMs))
  const markerTaskId = marker?.taskId ?? null

  return {
    isDriving: (id) => (markerTaskId !== null && id === markerTaskId) || claimed.has(id),
    markerTaskId,
    claimedIds: [...claimed],
    watcherLive,
    leasePid: watcherLive && owner ? owner.pid : null,
  }
}
