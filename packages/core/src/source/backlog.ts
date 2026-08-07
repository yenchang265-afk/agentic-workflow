import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { resolveClaimPredicate } from "../manifest/registry.js"
import type { WorkflowState } from "../workflow/state.js"
import type { Task } from "../task/schema.js"
import {
  claimFirst,
  confirmedStrayPlanRequestIds,
  extractPlan,
  extractReplanReason,
  findByIdIn,
  isRecoverable,
  isReleasableClaim,
  listByStatus,
  releaseClaim,
  selectOrder,
  STALE_CLAIM_MINUTES,
} from "../task/store.js"
import { consumePlanRequest, listPlanRequestIds, requestPlan, requestedFirst, revokeStrayPlanRequests } from "../task/plan-request.js"
import type { ClaimSkipReason, WorkItem, WorkSource } from "./types.js"
import { appendSchedulerEvents } from "../scheduler/events-log.js"

/**
 * The backlog-folder work source: claimable units of work are markdown task
 * files in the manifest's status folders (`workSource.pools`, walked in
 * priority order — for engineering: build-ready `in-progress/` beats planless
 * `queued/`). Claims stay atomic via the store's `.claims/` mkdir markers;
 * orphaned markers (a claimer that died) are released and retried inline.
 *
 * A pool may also carry `.requests/` plan-request markers (`task/plan-request.ts`)
 * — "plan THIS one next", written by a human through the hub. They reorder
 * candidates WITHIN their own pool and nothing more: the pool loop stays in
 * manifest priority order, so a request never preempts a higher-priority pool's
 * work, and it is spent the moment a claim honours it.
 */

/** A task's goal text: title headline plus its body, if any. Pure. */
export const taskGoal = (task: Task): string => (task.body ? `${task.title}\n\n${task.body}` : task.title)

interface Pool {
  readonly status: string
  readonly entryStage: string
  readonly claimPredicate?: string
}

interface BacklogDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Whether a live loop in this host instance is already driving the task id. */
  readonly isDriving: (id: string) => boolean
  /**
   * How long a claim marker may sit before it reads as orphaned. Derived from
   * the configured stage timeout (`staleClaimMinutes`), because a PLAN stage
   * writes nothing durable until it parks — judging it dead any earlier sweeps
   * a healthy run's marker. Absent ⇒ the bare `STALE_CLAIM_MINUTES` default.
   */
  readonly staleMinutes?: number
  /** The host name stamped on scheduler events (opencode/claude/qwen); "core" when absent. */
  readonly hostName?: string
}

/**
 * Compute why a poll claimed nothing, from what the claim walk saw across the
 * pools. Held markers win (they block otherwise-ready work); then empty
 * backlog; then started-but-unclaimed (recover); then the no-plan fallback.
 * Pure. The strings are engineering-flavored (this is the engineering
 * backlog's skip reporter); a future backlog-backed kind with different
 * folders should supply its own.
 */
export const claimSkipReason = (
  inProgressCount: number,
  claimableCount: number,
  queuedCount: number,
  startedIds: readonly string[],
  heldIds: readonly string[],
  // The window the claim walk ACTUALLY ran (deps.staleMinutes, default 75) —
  // quoting the bare constant promised a 15m auto-release the sweep would not
  // deliver for another hour.
  staleMinutes: number = STALE_CLAIM_MINUTES,
): ClaimSkipReason => {
  if (heldIds.length) {
    return {
      message:
        `watch: claim marker held for ${heldIds.join(", ")} — another watcher may be working it; ` +
        `a stale marker auto-releases after ${staleMinutes}m`,
      actionable: true,
    }
  }
  if (inProgressCount === 0 && queuedCount === 0) {
    return { message: "watch: nothing to claim — queued/ and in-progress/ are both empty", actionable: false }
  }
  if (claimableCount === 0 && startedIds.length) {
    return {
      message:
        `watch: 0 claimable — ${startedIds.length} in-progress task(s) already started: ` +
        `${startedIds.join(", ")} (run /agentic-workflow:engineering recover <id>)`,
      actionable: true,
    }
  }
  return {
    message:
      "watch: 0 claimable — in-progress task(s) have no persisted plan (send them back with /agentic-workflow:engineering replan <id>)",
    actionable: true,
  }
}

/** The entry WorkflowState for a task claimed from a pool. Pure. */
const entryState = (loaded: LoadedManifest, pool: Pool, task: Task): WorkflowState => {
  const plan = extractPlan(task)
  // The pending rejection reason threads into the entry state exactly as
  // `planEntryState` (orchestrate.ts) does for the explicit `plan <id>` path.
  // This builder serves the claim/watch path — the one most runs take — and
  // omitting it here meant plan.md's {{#replan}} section silently never
  // rendered on that path: the next PLAN pass re-planned blind to why the
  // human rejected the last plan. Not gated on the entry stage: a stage that
  // has no {{#replan}} section simply renders nothing, and gating would
  // hardcode engineering's shape into a generic work source.
  const replanReason = extractReplanReason(task)
  return {
    kind: loaded.manifest.kind,
    goal: taskGoal(task),
    stage: pool.entryStage,
    iteration: 0,
    artifacts: plan ? { plan } : {},
    ...(replanReason ? { replan: { reason: replanReason } } : {}),
    task: { id: task.id, path: task.path, acceptance: task.acceptance },
  }
}

/** The toast/log verb a claim announces. */
const claimVerb = (entryStage: string): string =>
  entryStage === "build" ? "building…" : entryStage === "plan" ? "planning…" : `${entryStage}…`

export const makeBacklogSource = (deps: BacklogDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, isDriving } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "backlog") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a backlog work source`)
  }
  const pools: readonly Pool[] = binding.pools

  const item = (pool: Pool, task: Task): WorkItem => ({
    id: task.id,
    workflowKind: loaded.manifest.kind,
    title: task.title,
    entryStage: pool.entryStage,
    state: entryState(loaded, pool, task),
    claimMessage: `Watch: claimed "${task.title}" — ${claimVerb(pool.entryStage)}`,
    ref: { pool, task },
  })

  /**
   * Drop requests whose task has left this pool — inert otherwise, but they
   * would sit there reordering nothing forever.
   *
   * The pool listing comes from the client index, which can lag the real
   * filesystem (the same reason `reverify` exists below), so every apparent
   * stray is confirmed absent on the real FS before it is deleted: sweeping a
   * live request would silently discard a human's ask. Best-effort throughout —
   * a failure here must never fail the claim walk.
   */
  const sweepStrayRequests = async (status: string, listed: readonly Task[]): Promise<void> => {
    try {
      // Every apparent stray is confirmed absent on the REAL filesystem before
      // it is revoked, and only the confirmed set is handed to the revoke — a
      // request that lands after this pass is never judged (the revoke
      // deliberately re-lists nothing), so a human's fresh ask survives the
      // sweep no matter how stale `listed` is.
      const strays = await confirmedStrayPlanRequestIds($, directory, tasksDir, listed.map((t) => t.id), status, log)
      const swept = await revokeStrayPlanRequests($, directory, tasksDir, strays, status)
      if (swept.length) await log("info", `backlog: swept ${swept.length} stray plan request(s): ${swept.join(", ")}`)
    } catch (err) {
      await log("warn", `backlog: plan-request sweep failed: ${(err as Error).message}`)
    }
  }

  return {
    workflowKind: loaded.manifest.kind,

    async claimNext() {
      const heldIds: string[] = []
      // Engineering skip-reason inputs (primary pool = build-ready work).
      let primaryTasks: readonly Task[] = []
      let primaryClaimable = 0
      let lastPoolCount = 0
      for (const [i, pool] of pools.entries()) {
        const tasks = await listByStatus(client, directory, tasksDir, pool.status, log)
        const predicate = pool.claimPredicate ? resolveClaimPredicate(pool.claimPredicate) : null
        const ordered = selectOrder(predicate ? tasks.filter(predicate) : tasks)
        // Read per pool, not once for the walk: each status folder owns its own
        // `.requests/`, so a request for a queued task can never hoist that id
        // once it has moved on to a higher-priority pool. Usually one `ls -1` of
        // an absent directory. A request reorders candidates WITHIN its pool
        // only — the pool loop stays in manifest priority order, so asking for a
        // plan never preempts build-ready work.
        const requested = new Set(await listPlanRequestIds($, directory, tasksDir, pool.status))
        const candidates = requestedFirst(ordered, requested)
        if (requested.size > 0) await sweepStrayRequests(pool.status, tasks)
        if (i === 0) {
          primaryTasks = tasks
          primaryClaimable = candidates.length
        }
        lastPoolCount = tasks.length
        const walk = await claimFirst($, candidates, {
          isDriving,
          log,
          ...(deps.staleMinutes === undefined ? {} : { staleMinutes: deps.staleMinutes }),
          // A stale-claim takeover is otherwise invisible on disk — record it in
          // the scheduler event log (best-effort, never fails the claim walk).
          onOrphanRelease: (id) =>
            appendSchedulerEvents($, directory, tasksDir, [
              { type: "claim-takeover", at: new Date().toISOString(), host: deps.hostName ?? "core", pid: process.pid, id },
            ]),
          // With a claim predicate, an orphaned marker is only released while
          // the body is still claimable (the dead run did no durable work);
          // without one (planless pools), a stale undriven marker is always
          // safe to release.
          isOrphaned: predicate
            ? (task, opts) => predicate(task) && !opts.drivenByLiveWorkflow && opts.markerStale
            : (_task, opts) => !opts.drivenByLiveWorkflow && opts.markerStale,
          // The candidate came from the client index, which can lag the real FS
          // (a just-finished run's mv + marker release may not be reflected yet)
          // — confirm on the real FS before handing the claim out, and hand out
          // the FRESH body so entryState reads current content.
          reverify: async (t) => {
            const fresh = await findByIdIn($, directory, tasksDir, pool.status, t.id, log)
            if (!fresh) return null // moved off the real FS (e.g. a done run's mv)
            if (predicate && !predicate(fresh)) return null // fresh body already claimed/started
            return fresh
          },
        })
        heldIds.push(...walk.heldIds)
        if (walk.claimed) {
          // The hint has been HONOURED, so spend it — on the winning claim only.
          // A lost or held claim keeps its request so the next tick still
          // prioritises the task, and `release()` restores a spent one: a
          // released claim did no work, so the human's ask still stands.
          // Spending it here is also why a died run leaves no sticky request
          // that re-plans forever — the ordinary walk picks the task up again
          // anyway.
          const consumedRequest =
            requested.has(walk.claimed.id) && (await consumePlanRequest($, directory, tasksDir, walk.claimed.id, pool.status))
          const claimed = item(pool, walk.claimed)
          return { item: consumedRequest ? { ...claimed, ref: { ...(claimed.ref as object), consumedRequest } } : claimed, skip: null }
        }
      }
      const started = primaryTasks.filter(isRecoverable).map((t) => t.id)
      return {
        item: null,
        skip: claimSkipReason(primaryTasks.length, primaryClaimable, lastPoolCount, started, heldIds, deps.staleMinutes),
      }
    },

    async release(work) {
      const { pool, task, consumedRequest } = work.ref as { pool: Pool; task: Task; consumedRequest?: boolean }
      // A released claim did no work, so a plan request the claim spent is
      // restored — without this the human's ask silently vanished whenever
      // setup (isolation, checks) threw after the claim consumed it.
      if (consumedRequest) await requestPlan($, directory, tasksDir, task.id)
      const fresh = await findByIdIn($, directory, tasksDir, pool.status, task.id)
      if (!fresh) {
        // The file left the pool (a racing move) or no longer parses — but the
        // pool's .claims/<id> marker is still held, and this is a drive-end
        // path: every way a drive ends must release the marker. Fall back to
        // the claim-time ref; releasing an already-released marker is a no-op.
        await releaseClaim($, task)
        return
      }
      // A predicate pool's claim is ours to hand back only while the run did no
      // durable work — a drive that reached a "BUILD started" audit note must
      // keep its marker for `recover <id>`.
      //
      // Gated on `isReleasableClaim`, NOT the pool's claim predicate: the caller
      // appends the CLAIMED note before establishing isolation and releases when
      // isolation throws, and `engineering.isClaimable` is false the moment that
      // note exists — so the predicate could never pass and every release was a
      // silent no-op, wedging the marker until a human ran `recover <id>`.
      // Planless pools (queued/PLAN) have no predicate and write no BUILD note,
      // so they keep releasing unconditionally.
      if (pool.claimPredicate && !isReleasableClaim(fresh)) return
      await releaseClaim($, fresh)
    },
  }
}
