import type { PluginInput } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@agentic-workflow/core/fsatomic"
import { type Task } from "@agentic-workflow/core/task/schema"
import { advance, composePrompt, firstStep, withCheckResults } from "@agentic-workflow/core/workflow/engine"
import {
  clearOpencodeStageMarker,
  opencodeStageMarker,
  taskDrivenByStageMarker,
  taskNamedByStageMarker,
  writeOpencodeStageMarker,
} from "@agentic-workflow/core/workflow/stage-marker"
import { registerEngineeringHooks } from "@agentic-workflow/core/kinds/engineering"
import { defaultWorkflowsDir } from "@agentic-workflow/core/manifest/dir"
import { stageDef, type LoadedManifest } from "@agentic-workflow/core/manifest/schema"
import { combineSkips, pollOnce } from "@agentic-workflow/core/scheduler/scheduler"
import { appendSchedulerEvents, skipSetKey, type SchedulerEvent } from "@agentic-workflow/core/scheduler/events-log"
import {
  buildEntryState,
  buildWorkSources,
  workflowWorkTree,
  makeManifestCache,
  planEntryState,
  taskGoal,
} from "@agentic-workflow/core/workflow/orchestrate"
import type { TerminalOutcome, WorkSource } from "@agentic-workflow/core/source/types"
import {
  ensureIsolation as coreEnsureIsolation,
  workflowId,
  teardownIsolation as coreTeardownIsolation,
} from "@agentic-workflow/core/workflow/isolate"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimFirst,
  claimTask,
  claimTaskSweepingStale,
  confirmedStrayPlanRequestIds,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedPlanClaim,
  isOrphanedStartedClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  listInProgress,
  listQueued,
  markClaimed,
  moveTask,
  refreshWorkClaim,
  releaseClaim,
  releaseOrphanedClaims,
  rescueStray,
  resolveTaskIdAnywhere,
  selectOrder,
  STALE_CLAIM_MINUTES,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-workflow/core/task/store"
import { consumePlanRequest, revokeStrayPlanRequests } from "@agentic-workflow/core/task/plan-request"
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import { staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { acquireLease, heartbeatLease, releaseLease } from "@agentic-workflow/core/scheduler/lease"
import {
  addWorktree,
  checkoutBranch,
  CHECKPOINT_LOCKFILE_EXCLUDES,
  commitAll,
  commitPaths,
  currentBranch,
  ensureExcluded,
  gitActor,
  isDirty,
  isGitRepo,
  pruneWorktrees,
  worktreeForBranch,
} from "@agentic-workflow/core/workflow/git"
import type { AdoGateway } from "@agentic-workflow/core/source/ado-gateway"
import { sharedAdoGateway } from "@agentic-workflow/ado-mcp/gateway"
import { clearState, loadState, saveState } from "@agentic-workflow/core/workflow/persist"
import { abandonTask, approveAny, rejectAny, removeTask, retaskTask, type GateCtx, type GateResult } from "@agentic-workflow/core/workflow/gate"
import { runTerminal, type TerminalCtx } from "@agentic-workflow/core/workflow/terminal"
import { type Outcome, renderRunSummary, type StageSample, type StageTokens, type StageToolUsage, verdictStructure } from "@agentic-workflow/core/workflow/metrics"
import { metricsPath, upsertRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import {
  admitVerdict,
  effectiveVerdict,
  mergeAxes,
  mergeRejected,
  noAdmissibleVerdictReason,
  WORKFLOW_REVIEW_TAG,
  WORKFLOW_VERIFY_TAG,
  parseVerdict,
  passFocusBlock,
  rejectedFallback,
  stageDriftNote,
  uncoveredAxes,
  withCoverageGap,
  type AxisResult,
  type RejectedVerdict,
  type StagePass,
  type Verdict,
  type VerdictRecord,
  worstOf,
} from "@agentic-workflow/core/workflow/verdict"
import { NO_OBSERVATIONS, type EvidenceContext, type ObservedEvidence } from "@agentic-workflow/core/workflow/evidence"
import { checkCommands, finalizeCheckRecord, runChecks } from "@agentic-workflow/core/workflow/checks"
import {
  EXPERIMENTAL_KINDS,
  checksFor,
  concurrencyFor,
  enabledWorkflowKinds,
  enforcesAxisCoverage,
  fanoutOverriddenByLenses,
  ignoredUserConfigPaths,
  modelFor,
  passAxes,
  resolveUserConfigPath,
  stagePasses,
  triggerFor,
  unknownStageCheckKeys,
  unknownStageConcurrencyKeys,
  unknownStageContextKeys,
  unknownStageFanoutKeys,
  unknownStageModelKeys,
  deprecatedAdoKeys,
  unreviewedAxes,
} from "@agentic-workflow/core/config"
import type { Config } from "../config.ts"
import { splitVerb } from "../verb.ts"
import { armCron, armIdle, armPoll, claimsOnIdle, cronError, type TriggerMode, type WatchTimerHandle } from "./trigger.js"
import type { Action, WorkflowState, Stage, TaskRef } from "@agentic-workflow/core/workflow/state"
import { anyWorkflowActive, clearWorkflow, findSessionDriving, getWorkflow, setWorkflow } from "@agentic-workflow/core/workflow/state"

/**
 * Impure orchestration for the agentic loop. Thin glue over the pure helpers in
 * `state.ts`.
 *
 * Stepping is **sequential**: `client.session.command` resolves with the
 * completed stage's assistant message, so the driver fires a stage, captures its
 * output, feeds it back into the pure `advanceOnIdle` decision, and repeats until
 * a non-`fire` action (gate / done / stop). `session.idle` is used only as the
 * trigger to begin a drive once the command's own turn settles; a pending
 * marker selects what to run and a driving lock prevents re-entrancy from the
 * idle events the driver's own commands generate.
 *
 * Task authoring happens **before** the loop, via `/agentic-workflow:engineering new <idea>`:
 * it interviews the user into a planless draft, and the deterministic
 * `approve <id>` verb (in `handleApprove`, folder-driven) parks it planless in
 * `queued/`. Planning happens **inside** the loop, right before execution, so
 * plans don't rot while a task sits parked: a claimed `queued/` task enters at
 * the PLAN stage (`startAtPlan`), which writes the `## Implementation Plan`
 * onto the task file and terminates with a `park` action — the driver moves
 * the task to `plan-review/` and the loop exits without blocking on a human.
 * `approve <id>` at that point is the human plan gate: it moves the
 * task to `in-progress/` — the build-ready queue — and the next claim enters at
 * `build` via `resumeAtBuild` with the approved plan threaded in as an artifact.
 *
 * PLAN, or BUILD → VERIFY → REVIEW, runs either on demand (`plan <id>` / a claim
 * claims one task) or via **watch mode** (the `watching` set + `tryClaim`): a
 * watching session scans `in-progress/` for one claimable task (`isClaimable`:
 * has a persisted plan, never started) — build work first — and falls back to
 * `queued/` for a task to plan. Watch is triggered two ways — every
 * `session.idle` event, plus a per-session interval timer (`watch
 * [interval]`) whose ticks call `onIdle` only when the session is actually
 * idle (queried via `client.session.status()`), so a task approved while the
 * session sat quiet still gets picked up. A VERIFY or REVIEW FAIL loops back
 * to `build` **inside this same session**, with the failure threaded into the
 * build prompt. Two watch sessions racing the same tick could both see a task
 * as claimable before either claims it; the atomic `claimTask` marker
 * resolves the race (in `queued/` and `in-progress/` alike).
 *
 * Task lifecycle: `/agentic-workflow:engineering new` authors into `draft/`; `approve <id>`
 * moves it to `queued/`; the loop's PLAN stage parks it in `plan-review/`;
 * `approve [id]` again (folder-driven) moves it to `in-progress/`; a
 * stop/failure while building appends a note and leaves it in `in-progress/`;
 * the loop finishing (review PASS) moves it to `in-review/`, the human diff
 * gate — a human runs the unified `approve` to move it to
 * `completed/`. If the plan itself turns out wrong (rejected at the gate, or
 * the iteration cap stops the loop), a human sends it back to `queued/` with
 * `replan <id> <why>` and the PLAN stage runs again with the
 * failure context threaded in.
 */

/** The workflow-kind manifests shipped with core (packages/core/workflows/<kind>/). */
const WORKFLOWS_DIR = defaultWorkflowsDir()
export const manifestFor = makeManifestCache(WORKFLOWS_DIR, ["engineering"])
const eng = manifestFor("engineering")
registerEngineeringHooks()

/** The work sources the scheduler polls, in claim-priority order (config order).
 *  An `only` kind restricts the poll to that one kind (claim/watch kind filter);
 *  a `target` PR number forces that exact PR on a PR-shaped `only` kind. */
const sourcesFor = (deps: Deps, config: Config, only?: string, target?: number): WorkSource[] =>
  buildWorkSources(
    {
      ...deps,
      isDriving: (id) => findSessionDriving(id) !== undefined,
      hostName: "opencode",
      ...adoGatewayDep(deps, config),
    },
    config,
    manifestFor,
    only,
    target,
  )

type Client = PluginInput["client"]
type Shell = PluginInput["$"]
type Log = (level: "info" | "warn" | "error", message: string) => unknown

/** Everything the driver needs from the plugin host, bundled once in index.ts. */
export interface Deps {
  readonly client: Client
  readonly $: Shell
  readonly directory: string
  readonly log: Log
}

/**
 * The Azure DevOps MCP gateway for this config as a spreadable fragment — `{}`
 * when ADO isn't configured, so a GitHub-only install never carries the key (or
 * spawns a server). One server per process; see `sharedAdoGateway`.
 */
const adoGatewayDep = (deps: Deps, config: Config): { adoGateway?: AdoGateway } => {
  const gateway = sharedAdoGateway(config, deps.log)
  return gateway ? { adoGateway: gateway } : {}
}

type Pending =
  | { readonly kind: "start-task"; readonly task: Task; readonly goal: string }
  | { readonly kind: "start-plan"; readonly task: Task; readonly goal: string }
  | { readonly kind: "recover"; readonly task: Task }
  | { readonly kind: "recover-state"; readonly state: WorkflowState }

const pending = new Map<string, Pending>()

/** The task whose on-disk claim marker a pending entry placed before it was queued. */
const pendingClaim = (p: Pending): { readonly id: string; readonly path: string } | undefined =>
  p.kind === "recover-state" ? p.state.task : p.task

/**
 * Release the claim marker an about-to-be-discarded pending placed. Every `pending`
 * entry is preceded by a `claimTask`, so a pending that is overwritten (a second
 * `plan <id>`) or dropped (`stop`/ESC) before `onIdle` drains it would leave
 * its task claim-held-but-undriven — invisible to every watcher until the stale-claim
 * sweep. Best-effort.
 */
const releasePendingMarker = async (deps: Deps, prior: Pending | undefined): Promise<void> => {
  const ref = prior && pendingClaim(prior)
  if (ref) await releaseClaim(deps.$, { id: ref.id, path: ref.path })
}

/** Queue a session's pending work, first releasing the marker of any prior unconsumed pending. */
const setPending = async (deps: Deps, sessionID: string, entry: Pending): Promise<void> => {
  await releasePendingMarker(deps, pending.get(sessionID))
  pending.set(sessionID, entry)
}

/** Drop a session's unconsumed pending work and release its claim marker. */
const dropPending = async (deps: Deps, sessionID: string): Promise<void> => {
  const prior = pending.get(sessionID)
  pending.delete(sessionID)
  await releasePendingMarker(deps, prior)
}
const driving = new Set<string>()
/** Sessions in `watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()
/** Sessions the user interrupted (ESC) mid-drive. Trips drive's stop guard after
 *  the current stage settles, so the loop halts without prematurely nulling
 *  `getWorkflow` (which `onIdle`'s catch still needs on a reject-on-abort). Cleared
 *  when the drive unwinds. */
const interrupted = new Set<string>()
/**
 * Sessions whose in-flight `session.abort` was issued by the DRIVER (a stage
 * timeout), mapped to a wall-clock expiry. In OpenCode a driver abort surfaces
 * as the exact same `MessageAbortedError` a user ESC does, so without this set
 * `onInterrupt` treated every stage timeout as a human interrupt: it killed
 * watch mode (dropping the clone's watch lease — the unattended watcher died on
 * the most likely failure of a long run) and toasted "Loop interrupted" for an
 * interrupt that never happened. Entries are judged against the expiry rather
 * than deleted on first sight because one abort dispatches multiple events
 * (session.error + message.updated, parent + subtask session); an expired entry
 * is dropped so a later real ESC is never swallowed.
 */
const driverAborts = new Map<string, number>()
/**
 * Driving session → the sessions its in-flight stage passes are running in.
 *
 * Only populated above concurrency 1 (at 1 a pass runs on the driving session
 * itself). Two jobs: `onInterrupt` needs to abort every in-flight pass, because
 * ESC reaches the session the user was looking at and the passes are elsewhere;
 * and `runStagePasses`' `finally` needs a list to clean up, since a pass that
 * threw between opening its session and closing it would otherwise leave a
 * registered state that reads as a live loop forever.
 */
const passSessions = new Map<string, Set<string>>()
/**
 * Should this session stop firing agent turns? Either a `stop` cleared the loop,
 * or the user pressed ESC. Both must be tested: `onInterrupt` deliberately keeps
 * `getWorkflow` set, so a `getWorkflow`-only check silently keeps working after an
 * interrupt (firing the remaining review lenses and the verdict retry).
 */
const halted = (sessionID: string): boolean => !getWorkflow(sessionID) || interrupted.has(sessionID)
/** Per-watching-session trigger timers (poll/cron/idle strategies) and modes. */
const watchTimers = new Map<string, WatchTimerHandle>()
const watchTriggerMode = new Map<string, TriggerMode>()
/** Per-watching-session workflow-kind filter (each kind command's `watch [interval]`). */
const watchKindFilter = new Map<string, string>()
/**
 * One-shot claim requests (`claim`), consumed by the next
 * `onIdle` — the command's own turn must settle before a drive may start, the
 * same deferral `task <id>` gets via `pending`. `kind` is the kind filter
 * (undefined = all enabled kinds); `target` is a specific PR number
 * (`claim <pr>` on a PR-shaped kind), which forces that PR's claim.
 */
const claimRequested = new Map<string, { kind?: string; target?: number }>()
/**
 * The clone's watch lease, refcounted per working directory: watch sessions in
 * THIS process share one on-disk lease (in-process races are covered by the
 * claim markers + `executingDirs`); the lease exists to refuse a SECOND
 * process watching the same clone — the cross-process race (threat-model T3)
 * the in-memory guards can't see. Last unwatch/stop releases it.
 */
const watchLeases = new Map<string, { count: number; deps: Deps; tasksDir: string; heartbeat: ReturnType<typeof setInterval> }>()
/**
 * The in-flight on-disk acquisition per directory. A second watch session arming the
 * same clone while the first is still awaiting `acquireLease` would otherwise read an
 * empty `watchLeases`, race its own `acquireLease` (which the first pid already holds),
 * and wrongly refuse ITSELF ("another watcher holds the lease"). Joiners await this
 * single acquisition instead and share the refcount — but never return ok until the
 * cross-process disk lease is actually held.
 */
const watchLeaseAcquiring = new Map<string, Promise<{ ok: true } | { ok: false; message: string }>>()

/**
 * Fixed lease-heartbeat cadence, decoupled from the trigger: a cron kind may
 * be quiet for hours and an idle kind has no timer at all, so liveness gets
 * its own timer. Written as the owner's `intervalMs`, it keeps the on-disk
 * staleness threshold (max(3×interval, 120s)) at a uniform 120s for every
 * trigger mode.
 */
const LEASE_HEARTBEAT_MS = 30_000

const leaseOwner = () => ({ pid: process.pid, host: os.hostname(), intervalMs: LEASE_HEARTBEAT_MS })

/** Acquire (or share) the clone's watch lease. On refusal, says who holds it. */
const acquireWatchLease = async (
  deps: Deps,
  config: Config,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const dir = deps.directory
  for (;;) {
    const existing = watchLeases.get(dir)
    if (existing) {
      existing.count += 1
      return { ok: true }
    }
    // Coalesce concurrent first-arms: joiners await the one in-flight acquisition,
    // then loop back to take the refcount fast-path on the entry it created. Looping
    // (not a one-shot `get`) matters: a concurrent last-unwatch can release the
    // entry between the acquisition resolving and this joiner's increment — a
    // silent `ok` here would hold NO share, and its later release would underflow
    // a future entry's refcount, dropping a lease another session still holds (T3).
    const inflight = watchLeaseAcquiring.get(dir)
    if (!inflight) break
    const res = await inflight
    if (!res.ok) return res
  }
  const attempt = (async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const res = await acquireLease(deps.$, dir, config.tasksDir, leaseOwner(), new Date())
    if (!res.ok) {
      const o = res.owner
      const ago = o && Number.isFinite(Date.parse(o.heartbeatAt)) ? Math.round((Date.now() - Date.parse(o.heartbeatAt)) / 1000) : null
      const who = o ? ` (pid ${o.pid} on ${o.host}${ago !== null ? `, heartbeat ${ago}s ago` : ""})` : ""
      return {
        ok: false,
        message: `Another watcher${who} holds this clone's watch lease — unwatch it there, or run this watcher in its own clone/worktree.`,
      }
    }
    // Prove liveness on a fixed cadence, busy or idle, whatever the trigger
    // mode — a watcher driving a long BUILD (or waiting on a distant cron
    // fire) must not read as dead to a would-be takeover.
    const heartbeat = setInterval(() => {
      void heartbeatLease(deps.$, dir, config.tasksDir, leaseOwner(), new Date()).catch(() => {})
    }, LEASE_HEARTBEAT_MS)
    watchLeases.set(dir, { count: 1, deps, tasksDir: config.tasksDir, heartbeat })
    return { ok: true }
  })()
  watchLeaseAcquiring.set(dir, attempt)
  try {
    return await attempt
  } finally {
    watchLeaseAcquiring.delete(dir)
  }
}

/** Drop one watch session's share of the lease; the last one releases it on disk. */
const releaseWatchLease = async (deps: Deps): Promise<void> => {
  const entry = watchLeases.get(deps.directory)
  if (!entry) return
  entry.count -= 1
  if (entry.count > 0) return
  watchLeases.delete(deps.directory)
  clearInterval(entry.heartbeat)
  // `leaseOwner()` is this process's identity — the same one that acquired and
  // heartbeats the lease. Passing it lets releaseLease refuse when we were taken
  // over while stalled, instead of deleting the new owner's lease (T3).
  await releaseLease(deps.$, deps.directory, entry.tasksDir, leaseOwner())
}
/**
 * Last no-claim reason toasted per watch session. Every tick logs its reason,
 * but the toast fires only when the reason CHANGES — a held marker or an
 * unplanned backlog would otherwise re-toast every 10s tick. Cleared on
 * successful claim, stop, unwatch, and (re-)watch so a re-arm re-toasts.
 */
const lastSkipReason = new Map<string, string>()
/**
 * Working directories with a drive in flight. All sessions of one opencode
 * instance share a single working tree and checked-out branch, so at most one
 * loop may drive stages in it at a time — a second would switch branches out
 * from under the first. (Separate opencode processes on the same clone are
 * NOT covered — run extra watchers in their own clones/worktrees.)
 */
const executingDirs = new Set<string>()

/** A check stage's name — validated against the driven kind's manifest. */
type CheckStage = string

/**
 * Verdicts recorded by the `workflow_verdict` tool, per session, consumed by the
 * drive loop right after the check stage that recorded them completes. This
 * tool call — not the stage's free text — is the authoritative channel;
 * text is untrusted (quoted contracts, echoed repo content).
 */
const recordedVerdicts = new Map<string, { readonly stage: CheckStage; readonly record: VerdictRecord }>()

/**
 * Verdicts `admitVerdict` REFUSED, per session — the pass's retry reads the
 * rejection message, and once the retry is spent `rejectedFallback` routes the
 * stage on what it declared (verdict.ts).
 *
 * Keyed by session exactly like `recordedVerdicts`, so a pass under
 * `stageConcurrency > 1` can never read a sibling's rejection. Kept for the whole
 * PASS (not cleared per attempt like the verdict tables): the fallback runs after
 * the retry, and an attempt that records nothing at all must not erase the
 * rejection the attempt before it produced.
 */
const rejectedVerdicts = new Map<string, { readonly stage: CheckStage; readonly rejected: RejectedVerdict }>()

/**
 * "I cannot do this work at all" signals from the `workflow_blocked` tool, per
 * session, consumed by the drive loop right after the WORK stage that recorded
 * one completes.
 *
 * Deliberately NOT the verdict channel. `recordVerdict` rejects a work stage on
 * purpose — a build agent must never be able to pre-empt its own verification —
 * and that invariant stays intact. This is a different claim ("the approved plan
 * is impossible") from a different tool, so a stage can refuse the work without
 * being able to grade it.
 */
const recordedBlocked = new Map<string, { readonly stage: string; readonly reason: string }>()

/**
 * Axes the running check stage's verdict must cover, per driving session.
 *
 * Published by `runStagePasses` rather than read from the manifest inside
 * `recordVerdict`, because a lens pass is told to "focus exclusively on
 * <lens>" — enforcing all five axes on it would reject every pass and deadlock
 * the loop. Lens mode therefore clears the requirement; it already enforces its
 * own coverage by turning a lens that recorded nothing into a synthetic ERROR.
 */
const axisRequirement = new Map<string, readonly string[]>()

/**
 * What each driving session's CURRENT check pass has been observed doing —
 * this host's half of the verdict's proof-of-work gate
 * (@agentic-workflow/core/workflow/evidence).
 *
 * In memory rather than the ledger file the Claude host writes, because this
 * host's tool guard runs in the same process as `recordVerdict`; the file exists
 * over there only because its guard is a separate process per tool call. Both
 * feed the same pure `EvidenceContext`.
 *
 * Cleared per PASS ATTEMPT (next to `recordedVerdicts`), so a re-fired check can
 * only be corroborated by its own work — never by the attempt that failed.
 */
const observedEvidence = new Map<string, ObservedEvidence>()

/** Most commands/reads kept per pass; see the Claude ledger's cap for why entries past it are dropped, not rotated. */
const OBSERVED_MAX = 200

/**
 * Note a tool call the guard is about to allow against the loop driving
 * `sessionID`. Called from `tool.execute.before` with the EFFECTIVE command (the
 * worktree pin may have rewritten it) — what will actually run is what counts as
 * having been run.
 */
export const noteEvidence = (sessionID: string, entry: { readonly command?: string; readonly reads?: readonly string[] }): void => {
  const prev = observedEvidence.get(sessionID) ?? NO_OBSERVATIONS
  const add = (list: readonly string[], incoming: readonly string[]): string[] => {
    const out = list.slice()
    for (const value of incoming) {
      if (out.length >= OBSERVED_MAX) break
      if (value && !out.includes(value)) out.push(value)
    }
    return out
  }
  observedEvidence.set(sessionID, {
    commands: add(prev.commands, entry.command ? [entry.command.trim()] : []),
    reads: add(prev.reads, (entry.reads ?? []).map((r) => r.trim())),
  })
}

/**
 * The stage a session has already audited an out-of-stage verdict for. A
 * drifting work stage typically calls `workflow_verdict` more than once (verify,
 * then review, inside the same build turn); the task file gets one note per
 * drifting stage, not one per call.
 */
const driftNoted = new Map<string, string>()

/** Usage observed for one stage pass — the assistant message's totals. */
interface StageUsage {
  readonly tokens: StageTokens
  readonly cost: number
  readonly model: string
}

/** Per-session run metrics, accumulated across a drive and rendered on termination. */
const runSamples = new Map<string, StageSample[]>()

/** Append a stage sample to this session's run metrics. */
const addSample = (sessionID: string, sample: StageSample): void => {
  const list = runSamples.get(sessionID) ?? []
  list.push(sample)
  runSamples.set(sessionID, list)
}

/**
 * Record a verdict from the `workflow_verdict` plugin tool. Only accepted while
 * this session's live loop is actually sitting in that check stage —
 * anything else (no loop, wrong stage, e.g. a build agent trying to
 * pre-empt its own verification) is ignored with an explanatory result.
 * The optional `reason`/`criteria` steer the next iteration's prompt only.
 *
 * `deps` is needed only to audit an out-of-stage verdict on the task file, so
 * it stays optional: the rejection itself is a pure decision, and tests that
 * assert it need no host. A caller that omits it still rejects correctly —
 * it just leaves the drift out of the audit trail.
 */
export const recordVerdict = (
  sessionID: string,
  stage: CheckStage,
  record: VerdictRecord,
  deps?: Deps,
): { readonly accepted: boolean; readonly message: string } => {
  const reject = (message: string) => ({ accepted: false, message })
  const state = getWorkflow(sessionID)
  if (!state) return reject("No active loop in this session — verdict ignored.")
  if (state.stage !== stage) {
    // The rejection alone reaches only the calling agent. Audit it on the task
    // so a work stage that ran a later stage's work inside its own turn is
    // visible in the trail, not just as odd behavior one stage later. Appended
    // at most once per stage attempt — a drifting agent may call repeatedly —
    // and fire-and-forget: the note must never delay or fail the tool result.
    if (deps && state.task && driftNoted.get(sessionID) !== state.stage) {
      driftNoted.set(sessionID, state.stage)
      const task = state.task
      void (async () => {
        await appendNote(
          deps.$,
          task,
          auditNote(stageDriftNote(state.stage, stage, record.verdict), new Date(), await gitActor(deps.$, deps.directory)),
          deps.log,
        )
      })().catch(() => {
        /* best-effort audit — never break the tool call */
      })
    }
    return reject(`The loop is at ${state.stage}, not ${stage} — verdict ignored. Only the running check stage may record its own verdict.`)
  }
  const def = manifestFor(state.kind ?? "engineering").manifest.stages.find((d) => d.name === stage)
  if (def?.kind !== "check") {
    return reject(`Stage ${stage} is not a check stage — verdict ignored.`)
  }
  // The stored record can only come from the `ok: true` branch, so a rejected
  // call cannot clobber a good record recorded earlier in the same pass.
  // Repeat calls combine worst-wins rather than overwrite — a FAIL must not be
  // replaceable by a later PASS from the same agent.
  const prev = recordedVerdicts.get(sessionID)
  // `observed` is whatever this pass has accumulated so far — never null on this
  // host, because the guard that fills it runs in this process: an empty set here
  // genuinely means the pass did nothing, which is exactly what should reject a PASS.
  const evidence: EvidenceContext = {
    stage,
    required: def.requireEvidence,
    observed: observedEvidence.get(sessionID) ?? NO_OBSERVATIONS,
  }
  const admission = admitVerdict(record, axisRequirement.get(sessionID), prev?.stage === stage ? prev.record : null, evidence)
  if (!admission.ok) {
    // Keep the refused record, not just the fact of a refusal: a stage that
    // reported twice and was refused twice is routed on what it DECLARED rather
    // than ERROR-stopping (see `rejectedFallback`). Rejections MERGE worst-wins
    // (`mergeRejected`) — keeping only the last one let a rejected FAIL vanish
    // behind a later rejected PASS, and the run ERROR-stopped instead of
    // rebuilding on the findings.
    const prevRejected = rejectedVerdicts.get(sessionID)
    rejectedVerdicts.set(sessionID, {
      stage,
      rejected: mergeRejected(prevRejected?.stage === stage ? prevRejected.rejected : null, { record, message: admission.message }),
    })
    return reject(admission.message)
  }
  recordedVerdicts.set(sessionID, { stage, record: admission.record })
  return { accepted: true, message: `Recorded ${stage} verdict: ${effectiveVerdict(admission.record)}.` }
}

/**
 * Record a "cannot do this work" signal from the `workflow_blocked` plugin tool.
 * Accepted only while this session's live loop is sitting in that WORK stage —
 * a check stage has the verdict channel and must use it, and a stage naming
 * someone else's is drift.
 *
 * The mirror image of `recordVerdict`'s guard: that one rejects work stages, this
 * one rejects check stages, so neither channel can stand in for the other.
 */
export const recordBlocked = (
  sessionID: string,
  stage: string,
  reason: string,
): { readonly accepted: boolean; readonly message: string } => {
  const reject = (message: string) => ({ accepted: false, message })
  const state = getWorkflow(sessionID)
  if (!state) return reject("No active loop in this session — blocked signal ignored.")
  if (state.stage !== stage) {
    return reject(`The loop is at ${state.stage}, not ${stage} — blocked signal ignored. Only the running stage may report itself blocked.`)
  }
  const def = manifestFor(state.kind ?? "engineering").manifest.stages.find((d) => d.name === stage)
  if (def?.kind !== "work") {
    return reject(`Stage ${stage} is a check stage — report PASS/FAIL/ERROR with workflow_verdict instead.`)
  }
  recordedBlocked.set(sessionID, { stage, reason })
  return {
    accepted: true,
    message: `Recorded ${stage} as blocked. The loop will stop and ask a human to replan; do not attempt the work.`,
  }
}

/** Consume (read-and-clear) a session's blocked signal for a work stage, if any. */
const takeBlocked = (sessionID: string, stage: string): string | null => {
  const entry = recordedBlocked.get(sessionID)
  if (!entry || entry.stage !== stage) return null
  recordedBlocked.delete(sessionID)
  return entry.reason
}

/**
 * Consume (read-and-clear) the verdict record for a session's check stage, if
 * any. A record for a DIFFERENT stage is left in place, not destroyed: it is
 * not this caller's to take, and the unconditional delete let a caller for
 * stage Y destroy a record belonging to stage X before X's owner read it.
 */
const takeVerdictRecord = (sessionID: string, stage: CheckStage): VerdictRecord | null => {
  const rec = recordedVerdicts.get(sessionID)
  if (!rec || rec.stage !== stage) return null
  recordedVerdicts.delete(sessionID)
  return rec.record
}

/**
 * The rejection a session's check stage last drew, if any. A PEEK, not a take:
 * the retry prompt reads it before the last attempt runs, and the fallback after
 * — `runStagePasses` clears it once per pass instead.
 */
const rejectedVerdictFor = (sessionID: string, stage: CheckStage): RejectedVerdict | null => {
  const entry = rejectedVerdicts.get(sessionID)
  return entry && entry.stage === stage ? entry.rejected : null
}

/**
 * Resolve the DRIVING session for a tool call. Check stages run as subtasks
 * (`subtask: true` commands), so `workflow_verdict` arrives with the CHILD
 * session's id — `getWorkflow` missed, the verdict was silently ignored, and the
 * stage read "none recorded → FAIL" even though the verifier called the tool
 * (its prose PASS is the untrusted channel and rightly ignored). Walk the
 * session's parentID chain until a session with a live loop is found.
 * Depth-capped; falls back to the given id so `recordVerdict` still reports
 * "no active loop" when nothing in the chain is driving.
 */
export const resolveDrivingSession = async (client: Client, sessionID: string): Promise<string> =>
  (await findDrivingWorkflow(client, sessionID).catch(() => null))?.sessionID ?? sessionID

/**
 * Strict core of `resolveDrivingSession`: resolve the loop driving `sessionID`
 * (itself or an ancestor, ≤5 hops). Returns null when the chain provably ends
 * with no loop, but THROWS on a session-API failure — the worktree-pinning
 * guard must fail CLOSED on "can't tell", not silently skip enforcement.
 */
export const findDrivingWorkflow = async (
  client: Client,
  sessionID: string,
): Promise<{ readonly sessionID: string; readonly state: WorkflowState } | null> => {
  let id = sessionID
  for (let depth = 0; depth < 5; depth++) {
    const state = getWorkflow(id)
    if (state) return { sessionID: id, state }
    const res = await client.session.get({ path: { id } })
    const parent = res?.data?.parentID
    if (!parent) return null
    id = parent
  }
  return null
}

const toast = (client: Client, message: string, variant: "info" | "success" | "warning" | "error") =>
  client.tui.showToast({ body: { message, variant } }).catch(() => {})

/**
 * The toast variant for a gate move. Core sets `variant` on a REFUSAL to grade
 * it (`info` = nothing to do, `warning` = wrong folder), and on a SUCCESS to
 * mark a move that landed with a caveat — a ship whose PR did not open. Without
 * honouring it on the ok branch, that ship toasts plain green and the note in
 * the message body is easy to scroll past.
 */
const gateVariant = (r: GateResult): "success" | "warning" | "info" => r.variant ?? (r.ok ? "success" : "warning")

/** Toast a terminal outcome AND return it, so the command hook can replace the
 *  rendered command template with what actually happened — otherwise the model
 *  reads the descriptive template as information and never reports the action. */
const report = async (
  client: Client,
  message: string,
  variant: "info" | "success" | "warning" | "error",
): Promise<string> => {
  await toast(client, message, variant)
  return message
}

/** Git isolation lives in core (`@agentic-workflow/core/workflow/isolate`); these
 *  wrappers thread this plugin's `Deps` into its host-agnostic signatures. */
const ensureIsolation = (deps: Deps, config: Config, state: WorkflowState): Promise<WorkflowState> =>
  coreEnsureIsolation(deps.$, deps.log, deps.directory, config, state)

const teardownIsolation = (deps: Deps, state: WorkflowState): Promise<void> =>
  // Gate on `isolated`, not `git`: a PR source pre-sets `git` to name the branch to
  // isolate onto, so a stage that never isolated (pr-sitter `triage` → done) must NOT
  // reach `coreTeardownIsolation`, which would checkout the base branch on the main tree.
  state.isolated ? coreTeardownIsolation(deps.$, deps.log, deps.directory, state) : Promise.resolve()

/** The working directory a loop's stages operate in: its worktree, else the main tree. */
const workTree = (deps: Deps, state: WorkflowState): string => workflowWorkTree(deps.directory, state)

/**
 * Run a stage's declared check commands and hang their results on the state, so
 * the fire that follows composes them into the prompt as established fact and
 * the finalizer can floor the verdict with them.
 *
 * Must run AFTER isolation: the checks belong in the work tree, against the code
 * the stage is about to judge, not against whatever the human's checkout holds.
 * Once per fire, not once per pass — every lens of a multi-lens review sees the
 * same results, and one review must not cost N test suites.
 *
 * Returns the state unchanged when nothing is declared, which keeps `checks`
 * off the state entirely and the composed prompt byte-identical to before.
 */
const runStageChecks = async (
  deps: Deps,
  config: Config,
  loaded: LoadedManifest,
  state: WorkflowState,
  stage: Stage,
): Promise<WorkflowState> => {
  const defs = checksFor(config, loaded.manifest.kind, stageDef(loaded.manifest, stage))
  if (!defs.length) return state
  const results = await runChecks(deps.$, defs, workTree(deps, state))
  for (const r of results) {
    if (r.outcome === "pass") continue
    await deps.log("warn", `${stage} check "${r.name}" exited ${r.exitCode} (${r.command})`)
  }
  return withCheckResults(state, stage, results)
}

/**
 * Serialize commits per git tree. In worktree mode `serialize` is off, so N in-process
 * watch drives run concurrently — and a command handler can fire mid-drive in either
 * mode — all committing the MAIN tree. Concurrent `git commit`s contend on
 * `.git/index.lock`; the loser's `commitPaths`/`commitAll` hits `.nothrow()`, returns
 * false, and the change never enters history (the fs task-move still lands, so it looks
 * committed). A per-tree promise chain makes each tree's commits run one at a time.
 * Keyed by tree path: a worktree's own index never contends with the main tree's.
 */
const commitLocks = new Map<string, Promise<unknown>>()
const withCommitLock = <T>(treePath: string, fn: () => Promise<T>): Promise<T> => withLock(commitLocks, treePath, fn)

/**
 * Run `fn` after every previously-queued call on the same key, on the given
 * chain map. The mechanism `withCommitLock` always used, lifted out because
 * concurrent stage passes need the same guarantee for two more shared writers
 * (see `runLocks`).
 *
 * Runs regardless of the prior call's outcome — a rejected predecessor must not
 * wedge the key forever — and the stored chain swallows results so a rejection
 * never surfaces as an unhandled one.
 */
const withLock = <T>(chains: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

/**
 * Serialize the per-run shared-file writers, keyed by workflow id.
 *
 * Sequential passes made these safe by accident; concurrent ones do not.
 * `appendRunLog` shell-appends `## <header>` blocks that `runlog.ts` parses back
 * out, and `flushMetrics` is a read-modify-write (`cat` → upsert → atomic
 * write) whose interleaving silently drops a sample. Both belong to one run, so
 * one chain per run keeps concurrent RUNS independent while making one run's
 * passes take turns.
 */
const runLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize passes that had to FALL BACK to the driving session, keyed by it.
 *
 * `session.create` failing must degrade to taking turns, never to two passes
 * sharing one session concurrently — that is the exact cross-admission the
 * per-pass session exists to prevent (one pass's verdict admitted against
 * another's axis requirement, one pass's evidence corroborating another's PASS,
 * `takeVerdictRecord` deleting a sibling's record on read). A separate map from
 * `runLocks` because a pass body takes the run lock internally, and one
 * non-reentrant chain would deadlock against itself.
 */
const sharedSessionPasses = new Map<string, Promise<unknown>>()

/** Commit everything as a checkpoint on the loop branch/worktree. No-op until isolation ran. */
const checkpoint = async (deps: Deps, config: Config, state: WorkflowState, message: string): Promise<void> => {
  // `isolated` (not `git`): don't `git add -A && commit` the human's main tree for a
  // loop whose pre-set `git` never became real isolation — that would sweep their WIP
  // into a bogus loop commit (pr-sitter `triage` → done on a dirty tree).
  if (!state.isolated) return
  const tree = workTree(deps, state)
  // Worktree checkpoints exclude the backlog dir: the worktree carries a frozen
  // checkout-time copy of `<tasksDir>` whose sweep onto feature/<id> resurrects
  // task files in the wrong status folder on merge. Shared-tree mode keeps
  // committing it — there the backlog deliberately rides the checkpoints.
  // Lockfiles are excluded in BOTH modes (see CHECKPOINT_LOCKFILE_EXCLUDES):
  // VERIFY's npm install churn must not ride the checkpoint into REVIEW's diff.
  const excludes = state.git?.worktree ? [config.tasksDir, ...CHECKPOINT_LOCKFILE_EXCLUDES] : [...CHECKPOINT_LOCKFILE_EXCLUDES]
  await withCommitLock(tree, () => commitAll(deps.$, tree, message, excludes))
}

/** Commit backlog path changes on the MAIN tree, serialized against other commits there. */
const commitTasks = (deps: Deps, config: Config, message: string): Promise<boolean> =>
  withCommitLock(deps.directory, () => commitPaths(deps.$, deps.directory, [config.tasksDir], message))

/**
 * Commit backlog mutations (audit notes, task moves) on the MAIN tree. In
 * shared mode these ride the loop-branch checkpoints; in worktree mode the
 * checkpoints commit the worktree, so terminal-event backlog changes must be
 * committed on the human's branch explicitly. No-op in shared mode.
 */
const commitBacklog = async (deps: Deps, config: Config, state: WorkflowState, message: string): Promise<void> => {
  if (!state.git?.worktree) return
  await commitTasks(deps, config, message)
}

/**
 * Durable claim evidence on the human branch, appended + committed BEFORE
 * isolation cuts feature/<id> (shared-tree mode checks the loop branch out in
 * place, so anything later lands there and the human branch's task file looks
 * untouched after teardown — the watcher would re-claim a finished task; see
 * core store.ts CLAIMED_MARKER).
 */
const markClaimedOnHumanBranch = async (deps: Deps, config: Config, task: { id: string; path: string }): Promise<void> => {
  await markClaimed(deps.$, task, await gitActor(deps.$, deps.directory), deps.log)
  await commitTasks(deps, config, `loop(${task.id}): claimed`)
}

/** The slash command a stage fires — named by the manifest (e.g. plan → `plan-task`). Pure. */
const stageCommand = (loaded: LoadedManifest, stage: Stage): string => stageDef(loaded.manifest, stage).command

/** How long a timed-out stage gets to actually settle after `session.abort`
 *  before the timeout error is allowed to unwind into checkpoint/teardown. */
const ABORT_GRACE_MS = 30_000

/**
 * Fire a stage command and return the assistant text it produced, plus the
 * usage totals (tokens/cost/model) the assistant message reports — previously
 * discarded, now recorded into the run metrics. Throws when the stage exceeds
 * the configured wall-clock cap — a hung stage must fail the loop (and
 * release its locks via onIdle's catch) rather than wedge the driver forever.
 * On timeout the underlying turn is aborted and given a bounded grace to
 * settle first: a merely-rejected race would leave the orphaned turn editing
 * files and running git WHILE onIdle's catch checkpoints and tears down
 * isolation in the same tree.
 */
/** Tools whose invocation means the pass wrote to a file (path lives in the tool input). */
const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/** Pull a file path from a tool call's input, tolerant of the key the tool uses. Pure. */
const filePathOf = (input: unknown): string | null => {
  if (!input || typeof input !== "object") return null
  const rec = input as Record<string, unknown>
  for (const key of ["filePath", "path", "file"]) {
    const v = rec[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return null
}

/** What a stage pass DID: per-tool call counts (+ errors) and the files it wrote.
 *  Undefined when the response carried no tool parts (e.g. the Claude host, or a
 *  no-tool pass) so the sample stays as slim as before. Pure. */
export const deriveActivity = (
  parts: readonly unknown[],
): { tools: readonly StageToolUsage[]; files?: readonly string[] } | undefined => {
  const counts = new Map<string, { count: number; errors: number }>()
  const files = new Set<string>()
  for (const p of parts) {
    if (!p || typeof p !== "object") continue
    const part = p as { type?: unknown; tool?: unknown; state?: unknown }
    if (part.type !== "tool" || typeof part.tool !== "string") continue
    const state = (part.state ?? {}) as { status?: unknown; input?: unknown }
    const prev = counts.get(part.tool) ?? { count: 0, errors: 0 }
    counts.set(part.tool, {
      count: prev.count + 1,
      errors: prev.errors + (state.status === "error" ? 1 : 0),
    })
    if (WRITE_TOOLS.has(part.tool.toLowerCase())) {
      const fp = filePathOf(state.input)
      if (fp) files.add(fp)
    }
  }
  if (counts.size === 0) return undefined
  const tools = [...counts.entries()]
    .map(([tool, c]) => ({ tool, count: c.count, errors: c.errors }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  return { tools, ...(files.size ? { files: [...files].sort() } : {}) }
}

const runStage = async (
  client: Client,
  sessionID: string,
  stage: string,
  args: string,
  timeoutMinutes: number,
  model?: string,
): Promise<{ text: string; usage?: StageUsage; activity?: { tools: readonly StageToolUsage[]; files?: readonly string[] } }> => {
  const command = client.session.command({
    path: { id: sessionID },
    body: { command: stage, arguments: args, ...(model ? { model } : {}) },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`${stage} stage timed out after ${timeoutMinutes} minutes`))
    }, timeoutMinutes * 60_000)
  })
  try {
    const res = await Promise.race([command, timeout])
    const parts = res.data?.parts ?? []
    const text = parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
    const info = res.data?.info
    const usage: StageUsage | undefined = info?.tokens
      ? {
          tokens: {
            input: info.tokens.input,
            output: info.tokens.output,
            reasoning: info.tokens.reasoning,
            cacheRead: info.tokens.cache.read,
            cacheWrite: info.tokens.cache.write,
          },
          cost: info.cost,
          model: info.modelID,
        }
      : undefined
    const activity = deriveActivity(parts)
    return { text, ...(usage ? { usage } : {}), ...(activity ? { activity } : {}) }
  } catch (err) {
    if (timedOut) {
      // Kill the orphaned turn before the timeout unwinds into teardown, and
      // swallow its eventual settlement so the lost race never surfaces as an
      // unhandled rejection. Both are best-effort: after the grace, failing
      // the loop still beats wedging the driver forever.
      // Mark the abort as driver-initiated FIRST: it surfaces as the same
      // MessageAbortedError a user ESC does, and onInterrupt must not treat a
      // stage timeout as a human interrupt (which killed watch mode). Filed
      // under the PASS session AND its driving session: closePassSession
      // unregisters the pass within this grace window, and a later event's
      // chain walk then lands on the driving session where a pass-keyed expiry
      // is invisible — the timeout read as a user ESC after all. (The driving
      // entry can swallow a real ESC landing inside the same window; the stage
      // is already unwinding through its timeout error path then, which is the
      // lesser harm.)
      const abortExpiry = Date.now() + ABORT_GRACE_MS * 2
      driverAborts.set(sessionID, abortExpiry)
      const drivingID = getWorkflow(sessionID)?.passOf
      if (drivingID) driverAborts.set(drivingID, abortExpiry)
      await client.session.abort({ path: { id: sessionID } }).catch(() => {})
      let grace: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        command.then(
          () => {},
          () => {},
        ),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, ABORT_GRACE_MS)
        }),
      ])
      clearTimeout(grace)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Combine the verdict records of several review-lens passes into one: the worst
 * verdict wins, and the reasons/failed-criteria of every non-PASS pass are
 * merged so the re-build prompt sees all objections. Pure.
 */
const combineRecords = (records: readonly (VerdictRecord | null)[], lenses: readonly string[]): VerdictRecord => {
  const verdict = worstOf(records.map((r) => (r ? effectiveVerdict(r) : null)))
  const reasons: string[] = []
  const criteria: { criterion: string; pass: boolean }[] = []
  let axes: AxisResult[] = []
  records.forEach((r, i) => {
    if (!r) return
    // Axes merge across EVERY pass, not just the failing ones: a lens that
    // passed an axis still holds evidence about it, and dropping that leaves a
    // later lens's FAIL rendering with no context. Per-axis worst-wins.
    axes = mergeAxes(axes, r.axes)
    // The EFFECTIVE verdict, matching line one of this function: a pass that
    // declared PASS while carrying a Critical axis finding is a failing pass,
    // and skipping it here silently dropped its reason and criteria from the
    // combined record.
    if (effectiveVerdict(r) === "PASS") return
    const lens = lenses[i]
    if (r.reason) reasons.push(lens ? `[${lens}] ${r.reason}` : r.reason)
    for (const c of r.criteria ?? []) criteria.push(c)
  })
  return {
    verdict,
    ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
    ...(criteria.length ? { criteria } : {}),
    ...(axes.length ? { axes } : {}),
  }
}

/**
 * Fire a stage, log its output to the run log, and (for check stages) capture
 * its verdict record. A check stage may expand into several focused passes —
 * one per configured review lens, or one per required axis under
 * `fanout: "axis"` — whose verdicts are combined worst-wins and whose non-PASS
 * outputs are concatenated, so a single injected reviewer can't flip the
 * outcome (threat model T1). Which passes run is `stagePasses`' decision, not
 * this function's. Every other stage runs exactly once. Stops firing further
 * passes if a `stop` clears the loop mid-pass. Exported for tests.
 */
export const runStagePasses = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  loaded: LoadedManifest,
  state: WorkflowState,
  stage: Stage,
  baseArgs: string,
  iteration: number,
  promptElided?: number,
): Promise<{ output: string; verdict: Verdict | null; record: VerdictRecord | null }> => {
  const def = stageDef(loaded.manifest, stage)
  const isCheck = def.kind === "check"
  const model = modelFor(config, loaded.manifest.kind, def)
  const passes = stagePasses(config, loaded.manifest.kind, def)
  const concurrency = concurrencyFor(config, loaded.manifest.kind, def, passes.length)
  // Positional, NOT append-order: under concurrency passes finish out of order,
  // and `combineRecords` + the missing-pass detection below both read
  // `records[i]` against `passes[i]`.
  const outputs: (string | null)[] = new Array(passes.length).fill(null)
  const records: (VerdictRecord | null)[] = new Array(passes.length).fill(null)
  // Rejections that outlived their pass's retry WITHOUT becoming a record (an
  // unearned PASS is never salvaged) — lifted out of the per-session map because
  // the stage's ERROR reason is composed after the pass sessions are gone, and
  // "the channel is unreachable, fix the plugin wiring" is the wrong diagnosis
  // for a channel that answered twice.
  const rejections: (RejectedVerdict | null)[] = new Array(passes.length).fill(null)
  const { client } = deps
  const runKey = workflowId(state)

  /**
   * The session ONE pass runs in.
   *
   * At concurrency 1 that is the driving session itself — the path a
   * single-pass stage and a lens fan-out still take, byte-identical.
   * Above 1 each pass needs its own, because every table a pass writes
   * (`recordedVerdicts`, `axisRequirement`, `observedEvidence`) is keyed by
   * session alone: sharing one id is precisely what forces passes to be serial.
   *
   * Created with `parentID` and NO `directory` override — the directory is what
   * plan 01 ruled out (it boots a second app instance, where this plugin and so
   * `workflow_verdict` do not exist). A sibling session in the same instance
   * keeps the verdict channel and gives `findDrivingWorkflow` a registered stop
   * before it reaches the driver, so the pass subagent's verdict lands on the
   * PASS. Falls back to the driving session if creation fails: a slower correct
   * stage beats a stage that cannot run.
   */
  const openPassSession = async (pass: StagePass): Promise<string> => {
    if (concurrency === 1) return sessionID
    try {
      const created = await client.session.create({
        body: { parentID: sessionID, ...(pass.focus ? { title: `${stage}: ${pass.focus}` } : {}) },
      })
      const id = created?.data?.id
      if (!id) throw new Error("session.create returned no id")
      setWorkflow(id, { ...state, passOf: sessionID })
      passSessions.get(sessionID)?.add(id)
      return id
    } catch (err) {
      await deps.log("warn", `${stage}: could not open a session for pass "${pass.focus ?? "single"}" — running it on the driving session (${(err as Error).message})`)
      return sessionID
    }
  }

  /** Tear a pass session down. Never the driving session — that outlives the stage. */
  const closePassSession = async (passSessionID: string): Promise<void> => {
    if (passSessionID === sessionID) return
    await client.session.delete({ path: { id: passSessionID } }).catch(() => {})
    // Unregister only AFTER the session is gone: a late workflow_verdict from
    // a subtask still settling in the abort-grace window walks up the parent
    // chain, and with the pass unregistered first it resolved to the DRIVING
    // session — landing in a table slot a sibling pass (or a shared-session
    // fallback) reads next. Registered, the pass soaks it up harmlessly.
    clearWorkflow(passSessionID)
    passSessions.get(sessionID)?.delete(passSessionID)
    // The pass's per-session table entries die with it — pass ids are never
    // reused, so anything left behind is a straight leak.
    recordedVerdicts.delete(passSessionID)
    rejectedVerdicts.delete(passSessionID)
    recordedBlocked.delete(passSessionID)
    observedEvidence.delete(passSessionID)
    axisRequirement.delete(passSessionID)
    driftNoted.delete(passSessionID)
  }

  const runOnePass = async (i: number): Promise<void> => {
    const pass = passes[i]!
    const passSessionID = await openPassSession(pass)
    // A pass that could not get its own session is back on the shared one, where
    // overlapping is precisely what corrupts verdicts. Degrade to taking turns.
    const shared = passSessionID === sessionID && concurrency > 1
    try {
      if (shared) await withLock(sharedSessionPasses, sessionID, () => runPassBody(i, pass, passSessionID))
      else await runPassBody(i, pass, passSessionID)
    } finally {
      await closePassSession(passSessionID)
    }
  }

  const runPassBody = async (i: number, pass: StagePass, passSessionID: string): Promise<void> => {
    // Publish THIS pass's axis requirement before firing; recordVerdict reads it
    // when workflow_verdict lands. An `axis` pass narrows it to its own axis, so
    // a focused pass is ACCEPTED instead of rejected for the axes it was told
    // not to review; a `lens` pass maps to no axis and clears it, exactly as
    // before. The stage-wide completeness guarantee moves to the coverage gate
    // below, which reads the accumulated record.
    const required = isCheck ? passAxes(def, pass) : undefined
    if (required?.length) axisRequirement.set(passSessionID, required)
    else axisRequirement.delete(passSessionID)
    const focusBlock = passFocusBlock(pass, i, passes.length)
    const args = focusBlock ? `${baseArgs}\n\n${focusBlock}` : baseArgs
    // One pass, plus at most one retry when a check stage ends with no
    // workflow_verdict call — a broken verdict channel is not a genuine FAIL, and
    // burning a build iteration on it re-built already-done work (the
    // theater-booking-0 failure mode; parity with the Claude host's retry).
    rejectedVerdicts.delete(passSessionID) // per PASS, not per attempt: the retry and the fallback both read it
    let passRecord: VerdictRecord | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      // A retry after a REJECTED verdict is a different instruction from a retry
      // after silence: the tool was called, the shape was refused, and the
      // rejection message is the only thing that makes the next call land.
      const rejected = isCheck ? rejectedVerdictFor(passSessionID, stage as CheckStage) : null
      const passArgs =
        attempt === 0
          ? args
          : rejected
            ? `${args}\n\nPREVIOUS ATTEMPT'S VERDICT WAS REJECTED and never recorded — ${rejected.message}\n` +
              `Call workflow_verdict ONCE more with that corrected (partial submissions are not accumulated).`
            : `${args}\n\nPREVIOUS ATTEMPT RECORDED NO VERDICT — the workflow_verdict tool call is MANDATORY. ` +
              `If the tool is not in your tool list, state that explicitly in your final message and finish.`
      // Scoped to the PASS session, which at concurrency 1 IS the driving session
      // (today's behavior exactly). Above 1 that scoping is what makes these
      // clears correct rather than a race: one pass's clear must never wipe a
      // sibling's verdict, nor its evidence corroborate a sibling's PASS.
      recordedVerdicts.delete(passSessionID) // no stale verdict may leak into this pass
      recordedBlocked.delete(passSessionID) // nor a stale "blocked" from an earlier stage
      observedEvidence.delete(passSessionID) // ...nor a previous pass's work corroborate this one's PASS
      // Seed the driver-run checks as observed work. They ARE observed — this
      // process ran them and holds their exit codes — and without the seed a
      // stage that correctly trusts the results instead of re-running them can
      // be observed doing nothing, have its PASS rejected by `evidenceIssue`,
      // and record a FAIL on a green suite. Re-seeded per attempt because the
      // clear above is per attempt.
      for (const command of checkCommands(state.checks?.[stage] ?? [])) noteEvidence(passSessionID, { command })
      driftNoted.delete(passSessionID) // one drift note per stage attempt, not per run
      // Each ATTEMPT gets a full stage timeout, so the advertised deadline and
      // the claim stamp are refreshed here, not once per stage: a fan-out
      // stage legitimately runs passes × attempts × timeout, and the stale
      // budget (`staleClaimMinutes`, the marker deadline) covers exactly one —
      // without the refresh a live REVIEW reads dead to doctor/recover
      // mid-fan-out and its claim is swept out from under it. Parity with the
      // Claude host, which restamps in every workflow_stage call.
      // `def.timeoutMinutes` (the manifest's per-stage override) wins over the
      // config default — the schema and hub have declared it for a while, but
      // only the Claude host honored it; here the override was silently ignored.
      const timeoutMinutes = def.timeoutMinutes ?? config.stageTimeoutMinutes
      await writeOpencodeStageMarker(
        deps.$,
        deps.directory,
        config.tasksDir,
        opencodeStageMarker(state, Date.now() + timeoutMinutes * 60_000),
      )
      await refreshWorkClaim(deps.$, state)
      const t0 = Date.now()
      const { text: out, usage, activity } = await runStage(
        client,
        passSessionID,
        stageCommand(loaded, stage),
        passArgs,
        timeoutMinutes,
        model,
      )
      const ms = Date.now() - t0
      const stamp = new Date().toISOString()
      const retryTag = attempt > 0 ? " · verdict retry" : ""
      // An axis reuses the `lens:` run-log slot rather than getting its own: the
      // parsers, the hub's per-pass flip streams and the token panel are all
      // already keyed on it, and a pass's focus is a pass's focus.
      const header = pass.focus
        ? `${stage} (lens: ${pass.focus}) · iteration ${iteration + 1}${retryTag} · ${stamp}`
        : `${stage} · iteration ${iteration + 1}${retryTag} · ${stamp}`
      // Under the run lock: `appendRunLog` shell-appends a `## <header>` block
      // that `runlog.ts` parses back out, so two passes appending at once would
      // interleave one run's log into unparseable halves.
      await withLock(runLocks, runKey, () =>
        appendRunLog(deps.$, deps.directory, config.tasksDir, runKey, header, out, deps.log),
      )
      outputs[i] = pass.focus ? `### Review ${pass.mode === "axis" ? "axis" : "lens"}: ${pass.focus}\n${out}` : out
      passRecord = isCheck ? takeVerdictRecord(passSessionID, stage as CheckStage) : null
      // The retry is spent and nothing was admitted: a pass that DID report — and
      // was refused — is routed on what it declared, so a rejected FAIL reaches
      // `advance` as this stage's FAIL and re-fires BUILD with the findings
      // instead of ERROR-stopping the run. Applied before the sample below so the
      // telemetry records the verdict the loop actually acted on, and only on the
      // LAST attempt so a first-attempt rejection still gets its retry.
      if (isCheck && !passRecord && attempt === 1) {
        passRecord = rejectedFallback(rejectedVerdictFor(passSessionID, stage as CheckStage))
        if (passRecord) {
          await deps.log(
            "warn",
            `${stage}${pass.focus ? ` (${pass.focus})` : ""} had its verdict rejected twice — recording it as declared (${effectiveVerdict(passRecord)})`,
          )
        }
      }
      // Samples stay on the DRIVING session: they are the run's telemetry, not
      // the pass session's, and the pass session is about to be deleted.
      addSample(sessionID, {
        stage,
        iteration,
        ms,
        ...(isCheck ? { verdict: passRecord?.verdict ?? "none" } : {}),
        ...(pass.focus ? { lens: pass.focus } : {}),
        startedAt: new Date(t0).toISOString(),
        // The length of what was actually FIRED, not of what core composed: the
        // focus instruction and the verdict-retry nag above are appended after
        // composition, and the honest number is what the model received.
        promptChars: passArgs.length,
        ...(promptElided ? { promptElided } : {}),
        ...(usage ? { tokens: usage.tokens, cost: usage.cost, model: usage.model } : {}),
        ...(activity ? { tools: activity.tools, ...(activity.files ? { files: activity.files } : {}) } : {}),
        // Structured verdict mirror (redacted) — what a cross-run "top recurring
        // findings" roll-up joins on; the prose keeps living in the run log.
        ...(isCheck ? verdictStructure(passRecord) : {}),
      })
      // Publish samples-so-far live (awaited: no flush I/O may be in flight when a
      // terminal event finalizes the sidecar). Under the run lock: the flush is a
      // read-modify-write (`cat` → upsert → atomic write), so two interleaved
      // flushes both read the same file and one pass's sample is lost.
      await withLock(runLocks, runKey, () => flushMetrics(deps, sessionID, config, state))
      // `halted` is always the DRIVING session's: a stop/ESC targets the loop,
      // and a pass session is never what the user interrupted.
      if (!isCheck || passRecord || halted(sessionID)) break
      if (attempt === 0) {
        await deps.log(
          "warn",
          `${stage}${pass.focus ? ` (${pass.focus})` : ""} recorded no verdict via workflow_verdict — re-running the pass once`,
        )
      }
    }
    records[i] = passRecord
    // Only meaningful when the pass produced no record; a salvaged one already
    // carries the rejection in its `reason`.
    if (!passRecord) rejections[i] = isCheck ? rejectedVerdictFor(passSessionID, stage as CheckStage) : null
    rejectedVerdicts.delete(passSessionID)
  }

  passSessions.set(sessionID, new Set())
  try {
    if (concurrency === 1) {
      // Byte-identical to the loop this replaced, including stopping early: a
      // halt must not fire the remaining passes.
      for (let i = 0; i < passes.length; i++) {
        await runOnePass(i)
        if (halted(sessionID)) break
      }
    } else {
      // A bounded pool: `concurrency` workers pulling from one cursor, so N
      // passes are in flight and no more. A worker checks the halt before
      // TAKING work, which is the concurrent equivalent of the sequential
      // early break — passes already in flight run to completion (their
      // sessions are aborted by `onInterrupt`), and none are started after.
      let cursor = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          if (halted(sessionID)) return
          const i = cursor++
          if (i >= passes.length) return
          await runOnePass(i)
        }
      }
      // `allSettled`, not `all`: one pass throwing (a stage timeout) must not
      // abandon its siblings mid-flight with their sessions still registered.
      // A thrown pass leaves `records[i] === null`, which the missing-pass
      // check below already reports as a broken channel.
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker))
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")
      if (failure && !halted(sessionID)) throw failure.reason
    }
  } finally {
    // Any pass session still registered (a throw between open and close) would
    // otherwise leak into the store and read as a live loop forever.
    for (const id of passSessions.get(sessionID) ?? []) {
      clearWorkflow(id)
      await client.session.delete({ path: { id } }).catch(() => {})
    }
    passSessions.delete(sessionID)
  }

  if (!isCheck) {
    // A work stage that called `workflow_blocked`: surface it as ERROR so
    // `advance` takes the manifest's `onError` arm (engineering build → stop,
    // "replan"). Kinds whose work stages declare no such arm fall back to
    // `onDone` inside the engine, so this is inert for them.
    const blocked = takeBlocked(sessionID, stage)
    if (blocked) {
      await deps.log("warn", `${stage} reported itself blocked — ${blocked}`)
      return { output: outputs[0] ?? "", verdict: "ERROR", record: { verdict: "ERROR", reason: blocked } }
    }
    return { output: outputs[0] ?? "", verdict: null, record: null }
  }

  /** The passes that produced output, in PASS order — a pass that never ran (halt) or threw contributes nothing. */
  const joinedOutput = outputs.filter((o): o is string => o !== null).join("\n\n")

  // A deliberate stop or an ESC interrupt mid-pass: records may be short and/or
  // end in null. The caller discards the result once halted — return quietly,
  // never routing it through the ERROR path below, which would report an
  // unreachable verdict channel for a stage the user simply stopped.
  if (halted(sessionID)) return { output: joinedOutput, verdict: null, record: null }

  // Focused passes that FIRED but recorded nothing even after their retry. A
  // missing pass verdict is a broken channel, not a FAIL: worst-wins combining
  // would read it as FAIL and burn a rebuild iteration on possibly-done work, so
  // it must take the same ERROR→recoverable-stop path as the single-pass case —
  // even when another pass recorded a genuine FAIL (a rebuild on partial
  // information is still wasted; the FAIL's output survives in the run log).
  const focused = passes.some((p) => p.focus !== null)
  const missingPasses = passes
    .map((p, i) => (i < records.length && records[i] === null ? p.focus : null))
    .filter((f): f is string => f !== null)
  const combined = focused
    ? missingPasses.length
      ? null
      : combineRecords(
          records,
          passes.map((p) => p.focus ?? ""),
        )
    : (records[0] ?? null)
  // The completeness guarantee focused passes exist to restore. Per-pass
  // enforcement proves each pass covered ITS axis, never that every axis ran —
  // only the accumulated record can show that. Mostly unreachable on this host
  // under fan-out (a pass that recorded nothing already took the ERROR path
  // above), and load-bearing under `reviewLenses` whose lenses span the stage's
  // axes: there per-pass coverage is not enforced at all, so this is the only
  // thing keeping `requiredAxes` required. See `enforcesAxisCoverage`.
  const gapped = combined && enforcesAxisCoverage(config, loaded.manifest.kind, def) ? uncoveredAxes(combined, def.requiredAxes) : []
  const gapChecked = combined && gapped.length ? withCoverageGap(combined, gapped) : combined
  // Floor the admitted record with the checks the driver ran, then refuse a
  // declared PASS whose every axis was unassessed. Applied HERE, at
  // finalization, and never inside `admitVerdict`: a pre-seeded check axis would
  // flow through `blockingFindingsIssue` and get a genuine agent PASS rejected
  // rather than derived down. Identity when every check passed and something
  // was assessed, so a green run records exactly what the agent recorded.
  const record = finalizeCheckRecord(gapChecked, state.checks?.[stage] ?? [])
  if (gapped.length) {
    await deps.log("warn", `${stage} fan-out finished with no result for ${gapped.join(", ")} — stopping with ERROR`)
  }
  // The DERIVED verdict — a pass that declared PASS while flagging a Critical
  // finding on an axis fails the stage (verdict.ts `effectiveVerdict`).
  const verdict = record ? effectiveVerdict(record) : null
  axisRequirement.delete(sessionID) // the stage is over; nothing may inherit its requirement
  if (verdict === null) {
    // Still nothing after the retry: nothing admissible ever landed — surface it
    // as a retryable ERROR (manifest onError → recoverable stop), never as a FAIL
    // that triggers a pointless rebuild. A stage whose calls were REJECTED rather
    // than absent is named as such: only an unearned PASS reaches here that way
    // (a rejected FAIL/ERROR was salvaged into a record above), and telling its
    // operator to fix plugin wiring would send them after a working channel.
    const inText = parseVerdict(joinedOutput, stage === "verify" ? WORKFLOW_VERIFY_TAG : WORKFLOW_REVIEW_TAG)
    const noun = passes.some((p) => p.mode === "axis") ? "axis" : "lens"
    const lensTag = missingPasses.length
      ? ` (${missingPasses.length > 1 ? (noun === "axis" ? "axes" : "lenses") : noun}: ${missingPasses.join(", ")})`
      : ""
    const rejected = rejections.find((r): r is RejectedVerdict => r !== null) ?? null
    await deps.log(
      "warn",
      `${stage} ${rejected ? "had every verdict rejected" : "recorded no verdict via workflow_verdict"} even after a retry${lensTag}` +
        `${inText ? ` (text claimed ${inText}, ignored — free text is untrusted)` : ""} — stopping with ERROR`,
    )
    const errorRecord: VerdictRecord = {
      verdict: "ERROR",
      reason: noAdmissibleVerdictReason({ rejected, detail: lensTag, prose: inText }),
    }
    return { output: joinedOutput, verdict: "ERROR", record: errorRecord }
  }
  return { output: joinedOutput, verdict, record }
}

/**
 * Persist a task-driven loop's state after a transition, so a crash/restart can
 * resume at the exact stage. No-op for free-text loops (no durable id yet).
 */
const snapshot = async (deps: Deps, config: Config, state: WorkflowState): Promise<void> => {
  if (!state.task) return
  await saveState(deps.$, deps.directory, config.tasksDir, state.task.id, state, deps.log)
}

/**
 * Flush this session's samples-so-far to the metrics sidecar as an `open` entry,
 * mid-run, so the hub can show tokens accruing per stage instead of only at
 * termination. Does NOT touch the run log or clear the accumulator — the
 * terminal `renderMetrics` still owns both. Best-effort: telemetry must never
 * fail the loop. Must be awaited (see the call site) so no flush write is in
 * flight when `renderMetrics` finalizes.
 */
const flushMetrics = async (deps: Deps, sessionID: string, config: Config, state: WorkflowState): Promise<void> => {
  const samples = runSamples.get(sessionID) ?? []
  if (samples.length === 0) return
  const file = metricsPath(deps.directory, config.tasksDir, workflowId(state))
  const existing = await deps.$`cat ${file}`.quiet().nothrow()
  const doc = upsertRunMetrics(existing.exitCode === 0 ? existing.stdout.toString() : null, {
    endedAt: new Date().toISOString(),
    detail: "",
    host: "opencode",
    sessionID,
    kind: state.kind ?? "engineering",
    samples,
    open: true,
  })
  await writeFileAtomic(deps.$, file, doc)
}

/**
 * Render this session's accumulated run metrics into the run log and clear the
 * accumulator. Called once per terminal event (done/stop/error). Best-effort —
 * never let telemetry failure disrupt the terminal handling.
 */
const renderMetrics = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  state: WorkflowState,
  outcome: Outcome,
  detail: string,
  retryable?: boolean,
): Promise<void> => {
  const samples = runSamples.get(sessionID) ?? []
  runSamples.delete(sessionID)
  driftNoted.delete(sessionID) // the run is over — nothing left to dedupe against
  recordedBlocked.delete(sessionID) // ditto: no blocked signal may outlive its run
  // Under the run lock like every other per-run writer (the AGENTS.md rule):
  // this is ordered after the pass pool drains today, so it was safe only by
  // call-site ordering — one refactor from interleaving with a late pass's
  // appendRunLog or flushMetrics. The lock makes the invariant local.
  const runKey = workflowId(state)
  await withLock(runLocks, runKey, async () => {
    // Report against the EFFECTIVE cap the engine enforced — a kind's manifest may
    // override `config.maxIterations` (pr-sitter caps at 3), so `config.maxIterations`
    // alone would mislabel the footer (e.g. "iterations used: 3/1").
    const cap = manifestFor(state.kind ?? "engineering").manifest.maxIterations ?? config.maxIterations
    const stamp = new Date().toISOString()
    const summary = renderRunSummary(samples, outcome, detail, cap, stamp, state.kind ?? "engineering")
    await appendRunLog(deps.$, deps.directory, config.tasksDir, runKey, `run · ${outcome}`, summary, deps.log)
    // Structured twin of the summary table — the machine-readable record token
    // dashboards join against. sessionID lets host storage be joined exactly.
    const file = metricsPath(deps.directory, config.tasksDir, runKey)
    const existing = await deps.$`cat ${file}`.quiet().nothrow()
    // Upsert (not append): replace the trailing `open` entry that the per-stage
    // flush left behind — appending here would double-count the run.
    const doc = upsertRunMetrics(existing.exitCode === 0 ? existing.stdout.toString() : null, {
      endedAt: stamp,
      outcome,
      detail,
      host: "opencode",
      sessionID,
      kind: state.kind ?? "engineering",
      ...(retryable !== undefined ? { retryable } : {}),
      samples,
    })
    await writeFileAtomic(deps.$, file, doc)
  })
}

/**
 * Live drives per working tree. The stage marker is ONE file per directory, but
 * worktree mode deliberately runs drives concurrently (`onIdle` skips the
 * serialize lock there) — so the first drive to finish must not delete the
 * advertisement out from under its still-running siblings. The marker's content
 * still names whichever drive wrote last (a display race the single-file format
 * can't avoid); this refcount only stops the premature DELETE, which blinded
 * the hub's driving oracle and doctor to a live loop.
 */
const drivesPerDir = new Map<string, number>()

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop.
 *  Returns the terminal outcome so callers can report it to the work source. */
export const drive = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: WorkflowState; action: Action },
): Promise<TerminalOutcome | null> => {
  drivesPerDir.set(deps.directory, (drivesPerDir.get(deps.directory) ?? 0) + 1)
  try {
    return await driveChain(deps, sessionID, config, first)
  } finally {
    // The chain advertises each live stage on disk (see the write below); every
    // exit — terminal, stop, interrupt, or a thrown stage error unwinding to
    // onIdle's catch — must take the advertisement down with it. Only the LAST
    // drive in this directory removes the file (see `drivesPerDir`).
    const remaining = (drivesPerDir.get(deps.directory) ?? 1) - 1
    if (remaining <= 0) {
      drivesPerDir.delete(deps.directory)
      await clearOpencodeStageMarker(deps.$, deps.directory, config.tasksDir)
    } else {
      drivesPerDir.set(deps.directory, remaining)
    }
  }
}

const driveChain = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: WorkflowState; action: Action },
): Promise<TerminalOutcome | null> => {
  const { client } = deps
  const loaded = manifestFor(first.state.kind ?? "engineering")
  // Azure DevOps is reached only through its REST API, so `ado.access` is inert
  // — name it rather than ignore it silently.
  const deadAdo = deprecatedAdoKeys(config)
  if (deadAdo.length) {
    await deps.log(
      "warn",
      `${deadAdo.join(", ")} ${deadAdo.length > 1 ? "are" : "is"} no longer supported — Azure DevOps is reached only ` +
        `through its REST API (curl/fetch + AZURE_DEVOPS_EXT_PAT). ${deadAdo.length > 1 ? "They are" : "It is"} ignored; ` +
        `remove ${deadAdo.length > 1 ? "them" : "it"} from .agentic-workflow.json.`,
    )
  }
  // A stageModels key naming no stage of this kind resolves to nothing and the
  // stage silently runs the host default — say so rather than let it read as
  // "model selection doesn't work".
  const unknownStages = unknownStageModelKeys(
    config,
    loaded.manifest.kind,
    loaded.manifest.stages.map((s) => s.name),
  )
  if (unknownStages.length) {
    await deps.log(
      "warn",
      `workflows.${loaded.manifest.kind}.stageModels names ${unknownStages.map((k) => `"${k}"`).join(", ")}, which is not a stage of this loop — ` +
        `ignored; the stage runs the host default model. Valid stages: ${loaded.manifest.stages.map((s) => s.name).join(", ")}.`,
    )
  }
  // Same trap for a stageContext key: a typo'd stage — or a typo'd artifact inside
  // a valid stage — leaves that prompt unbounded, which reads as "the budget did
  // nothing".
  const unknownBudgets = unknownStageContextKeys(
    config,
    loaded.manifest.kind,
    loaded.manifest.stages.map((s) => s.name),
  )
  if (unknownBudgets.length) {
    await deps.log(
      "warn",
      `workflows.${loaded.manifest.kind}.stageContext names ${unknownBudgets.map((k) => `"${k}"`).join(", ")}, which is not a stage of this loop — ` +
        `ignored; that prompt stays unbounded. Valid stages: ${loaded.manifest.stages.map((s) => s.name).join(", ")}.`,
    )
  }
  // Same trap for a stageChecks key, and a worse one to hit: a typo'd stage runs
  // NO checks, so the loop silently goes back to taking the agent's word for it.
  const unknownChecks = unknownStageCheckKeys(
    config,
    loaded.manifest.kind,
    loaded.manifest.stages.map((s) => s.name),
  )
  if (unknownChecks.length) {
    await deps.log(
      "warn",
      `workflows.${loaded.manifest.kind}.stageChecks names ${unknownChecks.map((k) => `"${k}"`).join(", ")}, which is not a stage of this loop — ` +
        `ignored; that stage runs NO check commands. Valid stages: ${loaded.manifest.stages.map((s) => s.name).join(", ")}.`,
    )
  }
  // Same trap for a stageFanout key: a typo'd stage never fans out, which reads
  // as "the setting doesn't work".
  const unknownFanouts = unknownStageFanoutKeys(
    config,
    loaded.manifest.kind,
    loaded.manifest.stages.map((s) => s.name),
  )
  if (unknownFanouts.length) {
    await deps.log(
      "warn",
      `workflows.${loaded.manifest.kind}.stageFanout names ${unknownFanouts.map((k) => `"${k}"`).join(", ")}, which is not a stage of this loop — ` +
        `ignored; that stage runs a single pass. Valid stages: ${loaded.manifest.stages.map((s) => s.name).join(", ")}.`,
    )
  }
  // Same trap for a stageConcurrency key: a typo'd stage silently runs at the
  // default concurrency instead — so the knob reads as "it doesn't work" rather
  // than "no such stage", whether the user was opting in or clamping down.
  const unknownConcurrency = unknownStageConcurrencyKeys(
    config,
    loaded.manifest.kind,
    loaded.manifest.stages.map((s) => s.name),
  )
  if (unknownConcurrency.length) {
    await deps.log(
      "warn",
      `workflows.${loaded.manifest.kind}.stageConcurrency names ${unknownConcurrency.map((k) => `"${k}"`).join(", ")}, which is not a stage of this loop — ` +
        `ignored; that stage's passes run at the default concurrency. Valid stages: ${loaded.manifest.stages.map((s) => s.name).join(", ")}.`,
    )
  }
  // reviewLenses suppresses per-pass axis-coverage enforcement, and the
  // stage-wide check only survives when the lenses between them span the stage's
  // axes — so name the axes no lens covers, and say what that costs.
  for (const def of loaded.manifest.stages) {
    const unreviewed = unreviewedAxes(config, def)
    if (!unreviewed.length) continue
    await deps.log(
      "warn",
      `reviewLenses is on and no lens covers ${unreviewed.map((a) => `"${a}"`).join(", ")}, so the ${def.name} stage ` +
        `does not enforce axis coverage at all — ${unreviewed.length > 1 ? "those axes go" : "that axis goes"} unreviewed. ` +
        `Add ${unreviewed.length > 1 ? "those lenses" : "that lens"} to get the coverage check back, or unset reviewLenses.`,
    )
  }
  // Both multi-pass knobs set: the lenses run and the per-axis fan-out does not.
  // Silence would make the fan-out look broken.
  for (const def of loaded.manifest.stages) {
    if (!fanoutOverriddenByLenses(config, loaded.manifest.kind, def)) continue
    await deps.log(
      "warn",
      `reviewLenses is configured, so the ${def.name} stage runs the lens passes instead of its declared per-axis ` +
        "fan-out — and per-pass axis coverage is not enforced. Unset reviewLenses to use the fan-out.",
    )
  }
  const actor = await gitActor(deps.$, deps.directory)
  let step = first
  while (step.action.kind === "fire") {
    // Every code-writing stage runs isolated: its own worktree (worktree mode)
    // or the feature/<id> branch in the shared tree (default). Created on the
    // first build; reconciled before every stage in case the tree/worktree
    // moved — including a snapshot-based `recover` that re-enters
    // directly at verify/review, where isolation must be re-established, not
    // assumed. PLAN is the exception: it writes only the task file (in the
    // main tree, on the human's branch) and parks, so it needs no branch, no
    // worktree, and no crash snapshot — a died PLAN is recovered by the stale
    // claim-marker sweep, not by recover.
    const isolated = stageDef(loaded.manifest, step.action.stage).isolation !== "none"
    if (isolated) {
      // Recompose the fire action from the POST-isolation state. The entry
      // action arrives composed from the claim-time state, which carries no
      // `git`/`worktree` — firing it as-is rendered the first BUILD's
      // `{{#worktree}}`/`{{#git}}` blocks empty, so the agent was never told
      // about its worktree and read the main tree while its edits landed in
      // the checkout (the Claude host isolates BEFORE composing; this matches).
      step = firstStep(loaded, await ensureIsolation(deps, config, step.state), config)
    }
    if (step.action.kind !== "fire") break // unreachable — firstStep always fires — but keeps the narrowing
    // Declared check commands run here — after isolation, before the fire — and
    // the prompt is recomposed so their exit codes reach the stage as fact
    // rather than as something it is asked to establish. No-op (and no
    // recompose) when the stage declares none.
    const checked = await runStageChecks(deps, config, loaded, step.state, step.action.stage)
    if (checked !== step.state) {
      step = firstStep(loaded, checked, config)
      if (step.action.kind !== "fire") break // same narrowing as above
    }
    const { stage, arguments: args } = step.action
    setWorkflow(sessionID, step.state)
    if (isolated) await snapshot(deps, config, step.state)
    // Advertise the live stage for out-of-process observers (the hub's driving
    // oracle, doctor, and board badge) — a SIBLING of the Claude host's
    // .stage.json, deliberately not the same file (see core's stage-marker.ts:
    // that path is a control input to the Claude plugin's hooks). Cleared by
    // drive()'s finally on every exit.
    await writeOpencodeStageMarker(
      deps.$,
      deps.directory,
      config.tasksDir,
      // The manifest's per-stage timeout override wins, as in runPassBody.
      opencodeStageMarker(step.state, Date.now() + (stageDef(loaded.manifest, stage).timeoutMinutes ?? config.stageTimeoutMinutes) * 60_000),
    )
    // Keep the claim stamp fresh at every stage boundary: `staleClaimMinutes`
    // covers one stage, but a whole loop can outlive it — without the refresh a
    // live run's marker reads as stale to another process's sweep/recover.
    // `refreshWorkClaim`, not `refreshClaimStamp`: a task-less sitter drive
    // restamps its own marker (state.claimMarkerDir) through the same seam.
    await refreshWorkClaim(deps.$, step.state)
    const { task, iteration } = step.state
    const trackBuild = stage === "build" && task
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD started (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    // A degraded isolation (detached HEAD, checkout failure) must be visible in
    // the task's audit trail, not just a console warn — the run otherwise looks
    // identical to an isolated one while writing into the main tree.
    if (trackBuild && isolated && step.state.isolationWarning) {
      await appendNote(
        deps.$,
        task,
        auditNote(`WARNING: ${stage.toUpperCase()} running WITHOUT isolation — ${step.state.isolationWarning}`, new Date(), actor),
        deps.log,
      )
    }
    const { output, verdict, record } = await runStagePasses(
      deps,
      sessionID,
      config,
      loaded,
      step.state,
      stage,
      args,
      iteration,
      step.action.kind === "fire" ? step.action.promptElided : undefined,
    )
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD finished (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    // Halt the chain when either a `stop` cleared this session's loop
    // while the stage ran, or the user interrupted (ESC) mid-drive — preserving
    // whatever the stage did as a checkpoint on the branch. The interrupt path
    // leaves `getWorkflow` set (so `onIdle`'s catch stays intact on a reject-on-abort),
    // so this block clears it itself.
    const wasInterrupted = interrupted.has(sessionID)
    if (!getWorkflow(sessionID) || wasInterrupted) {
      const how = wasInterrupted ? "interrupted" : "stopped"
      // Mirrors the `retryable: true` on this path's TerminalOutcome below.
      await renderMetrics(deps, sessionID, config, step.state, "stopped", `${how} during ${stage}`, true)
      await checkpoint(deps, config, step.state, `loop(${workflowId(step.state)}): incomplete — ${how} during ${stage}`)
      await teardownIsolation(deps, step.state)
      // The drive is over — release the claim marker (any stage). This guard
      // bypasses `runTerminal`, so without it an ESC/stop during PLAN left the
      // queued/ claim held: `plan <id>` then lied "just claimed by another
      // watcher" and only the 75-minute stale sweep freed it. A held marker
      // means "a loop is driving"; an interrupted (paused) run isn't — recover
      // re-claims when it resumes, and the CLAIMED note keeps watchers away.
      if (step.state.task) await releaseClaim(deps.$, step.state.task)
      // A deliberate stop ends the run — drop the snapshot so recover can't
      // resurrect stale state. An ESC interrupt is a pause: KEEP the snapshot so
      // recover <id> resumes at THIS stage (recover-state), not a BUILD
      // restart. A reject-on-abort already keeps it (onIdle's catch never clears state),
      // so both interrupt paths converge on exact-stage resume.
      if (step.state.task && !wasInterrupted) await clearState(deps.$, deps.directory, config.tasksDir, step.state.task.id)
      clearWorkflow(sessionID) // self-contained — no-op no-harm when stop already cleared it
      // A mid-drive interrupt / human ESC (or an externally-cleared loop) is not a
      // genuine exhaustion — mark it retryable so the work source keeps the item
      // claimable for the next poll rather than suppressing it forever (C2).
      return { kind: "stop", message: `${how} during ${stage}`, retryable: true }
    }
    // Checkpoint after any isolated code-writing (`work`) stage, not just the
    // engineering `build` — pr-sitter's `fix` stage writes code too and otherwise
    // gets no driver-side commit backstop if its agent forgets to commit.
    if (stageDef(loaded.manifest, stage).kind === "work" && isolated) {
      await checkpoint(deps, config, step.state, `loop(${workflowId(step.state)}): ${stage} iteration ${iteration + 1}`)
    }
    if (stageDef(loaded.manifest, stage).kind === "check" && task) {
      const failed = record?.criteria?.filter((c) => !c.pass).length ?? 0
      const detail = record?.reason ? ` — ${record.reason}` : ""
      const criteriaNote = failed ? ` (${failed} criteria unmet)` : ""
      await appendNote(
        deps.$,
        task,
        auditNote(
          `${stage.toUpperCase()} verdict: ${verdict ?? "none recorded → FAIL"}${criteriaNote}${detail} (iteration ${iteration + 1})`,
          new Date(),
          actor,
        ),
        deps.log,
      )
    }
    // A work stage that reported itself blocked leaves the same kind of trail. The
    // loop is about to stop and hand the task to a human to replan, and the reason
    // it stopped has to be readable in the task file rather than only in the run log.
    if (stageDef(loaded.manifest, stage).kind === "work" && verdict === "ERROR" && task) {
      await appendNote(
        deps.$,
        task,
        auditNote(
          `${stage.toUpperCase()} blocked — ${record?.reason ?? "no reason given"} (iteration ${iteration + 1})`,
          new Date(),
          actor,
        ),
        deps.log,
      )
    }
    // `advance` threads the machine-recorded failure reasons ahead of the stage's
    // prose itself (and records the seam, so a context budget can spare them), so
    // the record goes in raw — the fused text is byte-identical to what this site
    // used to build by hand.
    //
    // Interpret transitions against the CLAIMED kind's manifest — `loaded`, not
    // the hardcoded engineering `eng`. A pr-sitter loop (stages triage/fix/
    // verify/publish) would otherwise crash on its first transition, as
    // `stageDef(eng.manifest, "triage")` throws. For engineering, `loaded` IS
    // `eng` (same map entry), so this is byte-identical there.
    step = advance(loaded, step.state, config, output, verdict, record)
    // Publish the transition NOW, not at the top of the next iteration.
    // `setWorkflow` up there runs only AFTER `ensureIsolation` and
    // `runStageChecks`, which shell out and can take minutes — and throughout
    // that window `getWorkflow(sessionID).stage` still named the stage the loop
    // had already left. `recordVerdict` judges against exactly that field, so a
    // straggler workflow_verdict from the finished stage's subagent (still
    // settling in the abort-grace window `closePassSession` describes) was
    // ACCEPTED into the stage that just ended instead of rejected as drift. The
    // call up there stays: `step.state` is legitimately replaced by the isolation
    // and check-command recomposition above it, and this one cannot know that yet.
    setWorkflow(sessionID, step.state)
  }

  const { state, action } = step
  if (action.kind === "noop") return null

  // Terminal bookkeeping (park/done/stop) is shared with the Claude host in
  // `@agentic-workflow/core/workflow/terminal`. This host feeds it its commit/metrics
  // strategies as ports and renders the returned report as toasts.
  const ctx: TerminalCtx = {
    $: deps.$,
    log: deps.log,
    directory: deps.directory,
    config,
    state,
    manifest: loaded,
    actor,
    // Unconditional backlog commit on the main tree (serialized per tree); core
    // decides WHEN to call it (always on park, on done/stop only when a shared-tree
    // checkpoint won't fold the move in).
    commitBacklog: async (message) => void (await commitTasks(deps, config, message)),
    // Commit-all checkpoint on the work tree; core calls it only when state.isolated.
    checkpoint: (message) => checkpoint(deps, config, state, message),
    writeMetrics: (outcome, detail, retryable) => renderMetrics(deps, sessionID, config, state, outcome, detail, retryable),
  }
  const report = await runTerminal(ctx, action)
  clearWorkflow(sessionID)

  switch (report.kind) {
    case "error":
      await toast(client, report.message, "error")
      return { kind: "error", message: report.message }
    case "park-free":
      return { kind: "park", message: report.message }
    case "park":
      await toast(client, `${report.message} Review it, then /agentic-workflow:engineering approve (or replan <why>).`, "success")
      return { kind: "park", message: report.message }
    case "done": {
      if (report.taskId && !report.moved) {
        await toast(
          client,
          `Loop finished "${report.taskId}" but couldn't park it in in-review/ — it's still in in-progress/. Check the audit note.`,
          "warning",
        )
      } else {
        // "Done" for the loop is not "completed" for the task: a human still has to
        // look at the diff. The task parks in in-review/; moving it to completed/
        // (e.g. when the PR merges) is the human's call.
        const where = report.branch ? ` on branch ${report.branch}` : ""
        const next = report.taskId
          ? ` Review the diff${where}, then /agentic-workflow:engineering approve when it ships.`
          : where
            ? ` Review the diff${where}.`
            : ""
        await toast(client, `${report.message}${next}`, "success")
      }
      return { kind: "done", message: report.message }
    }
    case "stop": {
      const where = report.branch ? ` Partial work is preserved on branch ${report.branch}.` : ""
      await toast(client, `${report.message}${where}`, "warning")
      return { kind: "stop", message: report.message, ...(report.retryable ? { retryable: true } : {}) }
    }
  }
}

export { claimSkipReason } from "@agentic-workflow/core/source/backlog"
export type { ClaimSkipReason } from "@agentic-workflow/core/source/types"

/**
 * A `watch` session's own idle check, over two pools in order:
 * first a claimable task in `in-progress/` (plan approved, never started) is
 * driven straight through BUILD → VERIFY → REVIEW — build work beats plan
 * work, so in-flight tasks finish before new ones spin up. Otherwise a
 * `queued/` task (approved, planless) is claimed for the PLAN stage, which
 * writes its plan and parks it in `plan-review/` for the human gate.
 * FAIL-driven re-builds happen inline in this same session, exactly like a
 * normal loop's iteration cap. Never silent: when nothing is claimed, the
 * reason is always logged, and toasted when actionable (deduped until the
 * reason changes).
 */
/** Last-appended skip-set key per session — the event-log flood control. */
const lastSkipEventKey = new Map<string, string>()

/** `Omit` that distributes over the SchedulerEvent union (a plain Omit collapses it to the common keys). */
type SchedEventBody = SchedulerEvent extends infer E ? (E extends SchedulerEvent ? Omit<E, "at" | "host" | "pid"> : never) : never

/** Best-effort scheduler-event append, stamped with this host's identity. */
const emitSchedEvent = async (deps: Deps, config: Config, event: SchedEventBody): Promise<void> =>
  appendSchedulerEvents(deps.$, deps.directory, config.tasksDir, [
    { at: new Date().toISOString(), host: "opencode", pid: process.pid, ...event } as SchedulerEvent,
  ])

const tryClaim = async (deps: Deps, sessionID: string, config: Config, only?: string, target?: number): Promise<void> => {
  const kindFilter = only ?? watchKindFilter.get(sessionID)
  const { claim, skips } = await pollOnce(sourcesFor(deps, config, kindFilter, target))
  if (!claim) {
    const reason = combineSkips(skips)
    if (!reason) return
    // Append the skip-set only when it CHANGES — a watcher polls every tick and
    // an unconditional append would be the flood the event log must not become.
    const key = skipSetKey(skips)
    if (lastSkipEventKey.get(sessionID) !== key) {
      lastSkipEventKey.set(sessionID, key)
      await emitSchedEvent(deps, config, { type: "skip", reasons: [...skips] })
    }
    await deps.log(reason.actionable ? "warn" : "info", reason.message)
    if (reason.actionable && lastSkipReason.get(sessionID) !== reason.message) {
      lastSkipReason.set(sessionID, reason.message)
      await toast(deps.client, reason.message, "warning")
    }
    return
  }
  lastSkipReason.delete(sessionID)
  lastSkipEventKey.delete(sessionID)
  const { item } = claim
  await emitSchedEvent(deps, config, { type: "claim", kind: item.workflowKind, id: item.id })
  await toast(deps.client, item.claimMessage, "info")
  // Task-backed claims entering an isolated stage get the durable CLAIMED note
  // before drive() establishes isolation.
  if (item.state.task && stageDef(manifestFor(item.workflowKind).manifest, item.state.stage).isolation !== "none") {
    await markClaimedOnHumanBranch(deps, config, item.state.task)
  }
  try {
    const outcome = await drive(deps, sessionID, config, firstStep(manifestFor(item.workflowKind), item.state, config))
    if (outcome && claim.source.onTerminal) await claim.source.onTerminal(item, outcome)
    if (outcome) {
      await emitSchedEvent(deps, config, {
        type: "terminal",
        kind: item.workflowKind,
        id: item.id,
        outcome: outcome.kind,
        ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
      })
    }
  } catch (err) {
    // Died before real work started (e.g. ensureIsolation threw, before
    // setWorkflow ran — onIdle's catch can't see the task): the claim is ours, so
    // release it or watch stays wedged. The source knows what "real work"
    // means per pool (a BUILD-started note keeps the marker for recovery).
    await claim.source.release(item)
    await emitSchedEvent(deps, config, { type: "release", kind: item.workflowKind, id: item.id })
    throw err
  }
}

/** Which status folder a task id currently lives in, or null. For error messages. */
const findAnyStatus = async (deps: Deps, config: Config, id: string): Promise<TaskStatus | null> => {
  for (const status of STATUSES) {
    if (await findByIdIn(deps.$, deps.directory, config.tasksDir, status, id)) return status
  }
  return null
}

/** Load every status folder and roll it up. One list call per folder. */
const backlogSummary = async (deps: Deps, config: Config) => {
  const byStatus = {} as Record<TaskStatus, Task[]>
  for (const status of STATUSES) {
    byStatus[status] = await listByStatus(deps.client, deps.directory, config.tasksDir, status, deps.log)
  }
  const claimedIds = await listClaimIds(deps.$, deps.directory, config.tasksDir)
  return summarizeBacklog(byStatus, claimedIds)
}

/** Human-readable one-liner of the backlog roll-up. Pure. */
const formatBacklog = (s: Awaited<ReturnType<typeof backlogSummary>>): string => {
  const c = s.counts
  const drafts = s.awaitingTask.length > 0 ? `${c.draft} draft (${s.awaitingTask.length} awaiting approve)` : `${c.draft} draft`
  const gate = c["plan-review"] > 0 ? `${c["plan-review"]} plan-review (awaiting approve)` : "0 plan-review"
  const held = s.claimHeld.length ? `, ${s.claimHeld.length} claim-held` : ""
  const progress =
    c["in-progress"] > 0
      ? `${c["in-progress"]} in-progress (${s.claimable.length} ready${held}, ${s.interrupted.length} interrupted)`
      : "0 in-progress"
  return `backlog: ${drafts} · ${c.queued} queued · ${gate} · ${progress} · ${c["in-review"]} in-review · ${c.completed} completed · ${c.abandoned} abandoned`
}

/**
 * The shared "stop watching" cleanup: drop the session from `watching`, kill its
 * poll timer, forget its last skip reason, and release the clone's watch lease
 * (only if it was actually watching — a double release would corrupt the shared
 * per-directory refcount). Returns whether the session was watching. Every mutation
 * except the lease release is synchronous, so callers racing an idle event win.
 */
const stopWatching = async (deps: Deps, sessionID: string): Promise<boolean> => {
  const was = watching.delete(sessionID)
  stopWatchTimer(sessionID)
  lastSkipReason.delete(sessionID)
  watchKindFilter.delete(sessionID)
  if (was) await releaseWatchLease(deps)
  return was
}

/**
 * A user interrupt (ESC) mid-drive, routed from the plugin's event hook when a
 * `MessageAbortedError` lands on this session. Stops watching (no re-trigger on the
 * trailing idle) AND halts the current loop after the in-flight stage settles: the
 * `interrupted` flag trips drive's stop guard, and dropping `pending` cancels any
 * deferred one-shot work. Once the target session is known, mutations are synchronous
 * before the first `await` so a racing `session.idle` sees the cleared `watching`.
 * Idempotent — a double dispatch (session.error + message.updated for one ESC) is a
 * harmless no-op.
 */
export const onInterrupt = async (deps: Deps, sessionID: string): Promise<void> => {
  let state = getWorkflow(sessionID) // still set on the interrupt (the flag path keeps it)
  // Mid-drive the aborted assistant message belongs to the CHILD subtask
  // session (stages run as `subtask: true` commands), so the direct lookup
  // misses — and the interrupt would be a silent no-op on the wrong session:
  // the loop never flagged, the parent left in `watching`, and the trailing
  // idle free to re-claim work. Walk the parentID chain to the driving loop,
  // exactly like the tool guard and workflow_verdict do. Best-effort: on a
  // session-API failure fall back to the raw id (the old behavior).
  if (!state && anyWorkflowActive()) {
    const drive = await findDrivingWorkflow(deps.client, sessionID).catch(() => null)
    if (drive) {
      sessionID = drive.sessionID
      state = drive.state
    }
  }
  // The chain walk now stops at a PASS session when a fanned-out stage runs
  // concurrently — that registration is what routes the pass's verdict to the
  // pass. An interrupt must not stop there: `interrupted` is tested against the
  // DRIVING session (`halted`), the toast names the loop's task, and watch mode
  // is the driver's. Hop the one link `passOf` records, keeping the pass id for
  // the driver-abort test below (a pass stage timeout aborts the PASS session,
  // so that is the id the expiry was filed under).
  const passSessionID = state?.passOf ? sessionID : null
  if (state?.passOf) {
    sessionID = state.passOf
    state = getWorkflow(sessionID)
  }
  // A driver-initiated abort (stage timeout) is not a user interrupt: leave
  // watch mode armed and the loop's normal timeout error path in charge. Judged
  // by expiry, not delete-on-sight — one abort dispatches several events.
  for (const id of passSessionID ? [passSessionID, sessionID] : [sessionID]) {
    const driverAbortExpiry = driverAborts.get(id)
    if (driverAbortExpiry === undefined) continue
    if (Date.now() < driverAbortExpiry) return
    driverAborts.delete(id) // expired — a later real ESC must not be swallowed
  }
  // A real interrupt: stop the passes the user cannot see. They run in their own
  // sessions, so ESC on the driving session never reached them — without this
  // the remaining lens/axis turns keep burning after the user asked to stop.
  for (const id of passSessions.get(sessionID) ?? []) {
    await deps.client.session.abort({ path: { id } }).catch(() => {})
  }
  const hadWorkflow = state !== undefined
  const priorPending = pending.get(sessionID)
  pending.delete(sessionID) // synchronous — beat the racing idle; marker released below
  claimRequested.delete(sessionID) // a dropped one-shot claim must not fire on the trailing idle
  // Only flag when a loop is actually driving — otherwise the flag would linger
  // (no drive to consume it in onIdle's finally) and wrongly halt this session's
  // NEXT loop. A running stage always has getWorkflow set (drive's setWorkflow), so the
  // interruptable moment is covered.
  if (hadWorkflow) interrupted.add(sessionID)
  await releasePendingMarker(deps, priorPending) // dropped one-shot work must not leave a held claim
  const wasWatching = await stopWatching(deps, sessionID)
  // The interrupt keeps the snapshot, so recover resumes at the interrupted stage —
  // point the user straight at it.
  if (hadWorkflow) {
    const id = state?.task?.id
    const msg = id ? `Loop interrupted — run /agentic-workflow:engineering recover ${id} to resume.` : "Loop interrupted."
    await toast(deps.client, msg, "info")
  } else if (wasWatching) {
    await toast(deps.client, "Stopped watching — interrupted.", "info")
  }
}

/**
 * The watched session a user-interrupt event names, or undefined. A user ESC
 * surfaces only as a `MessageAbortedError` — on `message.updated` (assistant
 * message; `info.sessionID` always present, the primary signal) or `session.error`
 * (usable only when its optional `sessionID` is present). Everything else, including
 * `session.idle`, returns undefined so the normal flow is untouched. Pure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const abortedSessionID = (event: any): string | undefined => {
  if (event?.type === "message.updated") {
    const info = event.properties?.info
    if (info?.error?.name === "MessageAbortedError") return info.sessionID
  }
  if (event?.type === "session.error") {
    const p = event.properties
    if (p?.error?.name === "MessageAbortedError" && p.sessionID) return p.sessionID
  }
  return undefined
}

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  if (driving.has(sessionID)) return
  const work = pending.get(sessionID)
  // Nothing to do unless there's real pending work, a one-shot claim request,
  // or this is an idle watch session with no loop of its own currently running.
  const oneShotClaim = claimRequested.has(sessionID)
  // A plain idle event claims for poll/idle watchers only — cron kinds claim
  // exclusively when the schedule fires (which arrives as a one-shot claim).
  const idleMayClaim = claimsOnIdle(watchTriggerMode.get(sessionID) ?? "poll")
  const shouldWatch = ((watching.has(sessionID) && idleMayClaim) || oneShotClaim) && !getWorkflow(sessionID)
  if (!work && !shouldWatch) return
  // Serialize drives per working tree ONLY in shared-tree mode — there, two
  // loops would switch branches out from under each other. In worktree mode
  // each drive owns its own checkout, so concurrent drives are safe and the
  // lock is skipped (`ensureIsolation` throws rather than falling back to
  // shared-tree switching, so the main tree's HEAD is never touched).
  const serialize = !config.worktreesDir
  if (serialize && executingDirs.has(deps.directory)) return
  if (work) pending.delete(sessionID)
  driving.add(sessionID)
  if (serialize) executingDirs.add(deps.directory)
  try {
    if (work?.kind === "start-task" || work?.kind === "recover") {
      // `start-task`: a `plan <id>` / a claim claim entering execution at build.
      // `recover`: a human-forced resume of a started-but-dead task with no
      // valid snapshot. Both re-enter the state machine at build with the
      // persisted plan. Only a fresh start writes the durable CLAIMED note —
      // a recovered task already carries one (or a BUILD marker).
      if (work.kind === "start-task") await markClaimedOnHumanBranch(deps, config, work.task)
      await drive(deps, sessionID, config, firstStep(eng, buildEntryState(work.task), config))
    } else if (work?.kind === "start-plan") {
      // A `plan <id>` / a claim claim on a queued (planless) task: run the PLAN
      // stage, which writes the plan and parks the task in plan-review/.
      await drive(deps, sessionID, config, firstStep(eng, planEntryState(work.task), config))
    } else if (work?.kind === "recover-state") {
      // A snapshot-based resume: re-enter at the exact stage the crash caught,
      // with artifacts intact, re-firing that stage from its own inputs.
      await drive(deps, sessionID, config, firstStep(eng, work.state, config))
    } else {
      // No pending work — a watch session (or one-shot `claim`)
      // with nothing to resume; look for one claimable item across the
      // enabled workflow kinds.
      const requested = claimRequested.get(sessionID)
      claimRequested.delete(sessionID)
      await tryClaim(deps, sessionID, config, requested?.kind, requested?.target)
    }
  } catch (err) {
    const message = (err as Error).message
    const state = getWorkflow(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(`Loop error: ${message}`, new Date(), await gitActor(deps.$, deps.directory)),
        deps.log,
      )
    }
    // The drive died — release its claim marker unconditionally, whatever the
    // body says. The old gate (`isClaimable`) was always false once the CLAIMED
    // note landed, so every release was a silent no-op and the marker wedged
    // (the exact bug backlog.ts's `release` fixed with `isReleasableClaim`).
    // A held marker means "a loop is driving"; an errored one isn't — recover
    // re-claims, and the CLAIMED note keeps watchers away after release.
    const errored =
      work?.kind === "start-task" || work?.kind === "recover" || work?.kind === "start-plan"
        ? work.task
        : work?.kind === "recover-state"
          ? work.state.task
          : undefined
    if (errored) await releaseClaim(deps.$, errored)
    // Preserve whatever the failed run left behind and put the tree back.
    if (state) {
      await renderMetrics(deps, sessionID, config, state, "error", message)
      if (state.task) await commitBacklog(deps, config, state, `loop(${state.task.id}): loop error — ${message}`)
      await checkpoint(deps, config, state, `loop(${workflowId(state)}): incomplete — loop error`)
      await teardownIsolation(deps, state)
    } else {
      runSamples.delete(sessionID)
    }
    clearWorkflow(sessionID)
    await toast(deps.client, `Loop error: ${message}`, "error")
  } finally {
    driving.delete(sessionID)
    interrupted.delete(sessionID) // consumed by this drive; a fresh drive re-arms via onInterrupt
    if (serialize) executingDirs.delete(deps.directory)
  }
}

// --- /agentic-workflow:<kind> command handling (parses the verb; deferred work runs on next idle) ---

/** Minimum watch polling cadence — anything tighter just burns idle queries. */
const MIN_WATCH_INTERVAL_MS = 10_000

/** Parse one interval token (`30s`, `5m`, `2h`, bare minutes, `10 M`), or null. Pure. */
const parseIntervalSpec = (s: string): { intervalMs: number } | null => {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(s)
  if (!m || Number(m[1]) <= 0) return null
  const value = Number(m[1])
  const unit = (m[2] ?? "").toLowerCase() || "m"
  const ms = value * (unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000)
  return { intervalMs: Math.max(ms, MIN_WATCH_INTERVAL_MS) }
}

/** A per-session trigger override parsed from `watch` arguments. */
export type WatchOverride =
  | { readonly type: "poll"; readonly intervalMs?: number }
  | { readonly type: "cron"; readonly schedule: string }
  | { readonly type: "idle" }

/**
 * Parse the arguments of `watch [poll [interval] | cron <schedule> | idle |
 * <interval>]`. `""` → {} (the kind's configured trigger decides); everything
 * else is a per-session trigger override: `idle`, `cron <5-field schedule>`
 * (validated here), `poll [interval]`, or a bare interval (`30s`, `5m`, `2h`,
 * bare minutes — the long-standing poll shorthand, optional `--interval `
 * prefix). Intervals clamp to at least 10 seconds. The kind is no longer an
 * argument — each per-kind command scopes its own watch. Pure.
 */
export const parseWatchArgs = (spec: string): { trigger?: WatchOverride } | { error: string } => {
  const s = spec.trim().replace(/^--interval\s+/i, "")
  if (!s) return {}
  if (/^idle$/i.test(s)) return { trigger: { type: "idle" } }
  const cron = /^cron\s+(.+)$/i.exec(s)
  if (cron) {
    const schedule = (cron[1] as string).trim().replace(/^"(.*)"$/, "$1")
    const error = cronError(schedule)
    if (error) return { error: `Not a valid cron schedule "${schedule}" — ${error}` }
    return { trigger: { type: "cron", schedule } }
  }
  const poll = /^poll(?:\s+(.+))?$/i.exec(s)
  if (poll) {
    const rest = (poll[1] ?? "").trim()
    if (!rest) return { trigger: { type: "poll" } }
    const parsed = parseIntervalSpec(rest)
    if (!parsed) return { error: `Unrecognized poll interval "${rest}" — use e.g. 30s, 5m, 2h, or a bare number of minutes.` }
    return { trigger: { type: "poll", intervalMs: parsed.intervalMs } }
  }
  const parsed = parseIntervalSpec(s)
  if (!parsed) {
    return {
      error: `Unrecognized watch argument "${spec.trim()}" — use an interval (30s, 5m, 2h), poll [interval], cron <schedule>, or idle.`,
    }
  }
  return { trigger: { type: "poll", intervalMs: parsed.intervalMs } }
}

/** Clear one session's watch trigger timer, if any. */
const stopWatchTimer = (sessionID: string): void => {
  watchTimers.get(sessionID)?.stop()
  watchTimers.delete(sessionID)
  watchTriggerMode.delete(sessionID)
}

/** Clear every watch timer and drop held leases — called from the plugin's dispose hook. */
export const disposeWatch = (): void => {
  for (const handle of watchTimers.values()) handle.stop()
  watchTimers.clear()
  watchTriggerMode.clear()
  for (const [dir, entry] of watchLeases) {
    watchLeases.delete(dir)
    clearInterval(entry.heartbeat)
    void releaseLease(entry.deps.$, dir, entry.tasksDir, leaseOwner())
  }
}

/**
 * One watch-timer tick: claim work only when this session is genuinely quiet.
 * The `session.idle` event path stays the fast trigger; the timer exists for
 * the case that path misses — a task approved (by `approve` in
 * another session) while this session sat idle generating no new events.
 * Idleness is queried, not tracked: absent from the status map counts as idle.
 * Never throws — an unhandled rejection inside a timer would crash the host.
 */
const watchTick = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  try {
    if (!watching.has(sessionID)) return
    if (driving.has(sessionID) || getWorkflow(sessionID)) return
    const res = await deps.client.session.status().catch(() => null)
    const status = res?.data?.[sessionID]
    if (status && status.type !== "idle") return
    await onIdle(deps, sessionID, config)
  } catch (err) {
    await deps.log("warn", `loop: watch tick failed: ${(err as Error).message}`)
  }
}

/** The engineering command as the user types it — for toasts and usage text. */
const ECMD = "/agentic-workflow:engineering"

// --- Shared human-gate transitions -----------------------------------------
/**
 * Build the shared gate context from this host's deps. `isDriving` answers from
 * the in-memory session map so replan refuses a task a live loop is building.
 */
const gateCtx = (deps: Deps, config: Config): GateCtx => ({
  $: deps.$,
  client: deps.client,
  log: deps.log,
  directory: deps.directory,
  config,
  isDriving: (id) => findSessionDriving(id) !== undefined,
  ...adoGatewayDep(deps, config),
})

/**
 * Handle `approve [id]` — the unified, folder-driven gate (the only approval
 * verb). With an explicit id it advances that task by the gate its folder
 * implies: `draft/` → queued (task gate), `plan-review/` → in-progress
 * (plan gate, plan required), or `in-review/` → completed (ship). Without an
 * id it advances the single task at a loop wait-gate (`plan-review/` or
 * `in-review/`), falling back to `draft/` only when neither has anything
 * waiting: the loop's own gates outrank the authoring gate, so a parked plan is
 * never shadowed by a pile of drafts. The never-approve epic tracking draft is
 * skipped in the id-less scan — leaving it in was what made drafts produce
 * false "multiple awaiting" and risk queuing the wrong one.
 *
 * Report-and-stop, like replan: every arm — the folder-driven resolution, the
 * three gate moves, the ship's push/PR — is deterministic in core, and
 * `noteThenMove` reports a failed move itself, so there is nothing left for a
 * model turn to verify. The returned outcome replaces the rendered markdown;
 * the markdown's approve block survives only when the plugin never ran, and
 * is written as that tripwire.
 */
export const handleApprove = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<string> => {
  const { client } = deps
  const id = args.trim().split(/\s+/).filter(Boolean)[0] ?? ""
  try {
    const r = await approveAny(gateCtx(deps, config), id)
    return report(client, r.message, gateVariant(r))
  } catch (err) {
    return report(client, `Approve failed${id ? ` for "${id}"` : ""}: ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `retask <id>` — the deterministic half of the authoring verb. The
 * interview and the rewrite are the agent's work, but WHERE the task must sit
 * before that is the plugin's: a `queued/` task is moved back to `draft/` (its
 * approval withdrawn), a `draft/` task is already right, and a planned task is
 * refused with a pointer at `replan`.
 *
 * The deterministic arms — no id, a refusal, a hard failure — are
 * report-and-stop: their outcome replaces the rendered markdown, so the
 * interview never runs against a task that is not in `draft/`. Only a
 * successful placement returns undefined and lets the interview markdown
 * through; its "resolve in draft/ only" step remains as the backstop for a
 * plugin that never ran at all.
 */
export const handleRetask = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<string | undefined> => {
  const { client } = deps
  // Split the id off the note verbatim rather than on whitespace — the note is
  // the human's prose and reaches the task file's audit trail intact.
  const parsed = /^(\S+)\s*([\s\S]*)$/.exec(args.trim())
  const id = parsed?.[1] ?? ""
  if (!id) return report(client, `Usage: ${ECMD} retask <id> [note].`, "warning")
  const note = parsed?.[2]?.trim() || undefined
  try {
    const r = await retaskTask(gateCtx(deps, config), id, note)
    if (!r.ok) return report(client, r.message, gateVariant(r))
    // Success is silent unless the plugin actually moved something — the agent's
    // turn reports the reshape, and a toast per retask would double up.
    if (!r.data?.alreadyDone) await toast(client, r.message, gateVariant(r))
    return
  } catch (err) {
    return report(client, `Retask failed for "${id}": ${(err as Error).message}`, "error")
  }
}

/**
 * Claim a queued task and queue a PLAN drive on this session — the one
 * primitive every "plan it now" path shares (`plan <id>`, replan's chained
 * re-plan). False = lost the claim race to another watcher, which then plans
 * it there. Callers own the busy/liveness guards; this owns the atomic claim,
 * spending any plan-request marker, and deferring the drive to the next idle.
 */
const claimForPlan = async (deps: Deps, sessionID: string, task: Task, config: Config): Promise<boolean> => {
  if (!(await claimTask(deps.$, task))) return false
  // Planning it now honours any plan request for it just as a claim walk
  // would, so the marker must not outlive this — otherwise the board keeps
  // showing "plan requested" for a task that is being planned right now.
  await consumePlanRequest(deps.$, deps.directory, config.tasksDir, task.id, "queued")
  clearWorkflow(sessionID)
  await setPending(deps, sessionID, { kind: "start-plan", task, goal: taskGoal(task) })
  return true
}

/**
 * Handle `replan [id] [reason]` — the sole rejection verb, and since what the
 * gate wants is a REVISED plan, it chains the re-plan: core records the
 * rejection and re-queues the task plan-next, then this session claims it and
 * fires a PLAN pass immediately — the revised plan parks back in
 * `plan-review/` with the rejection reason threaded into its prompt.
 * Auto-targets the single `plan-review/` task; an explicit id may also name an
 * `in-progress/` (cap-tripped) task. When no leading token names a rejectable
 * task, the whole argument is treated as the reason and the single plan-review
 * task is chosen.
 *
 * The rejection half stays report-and-stop: resolve, refuse (live loop /
 * claim marker), move, record the reason, commit — all deterministic in core,
 * and `noteThenMove` reports a failed move itself. The chain is best-effort on
 * top: a busy session, a claim race, or a stale core dist (no `data.id`)
 * falls back to reporting core's outcome, whose plan-next marker already
 * promises the next worker re-plans this task first. The returned outcome
 * replaces the rendered markdown; the markdown's replan block survives only
 * when the plugin never ran, and is written as that tripwire.
 */
export const handleReplan = async (deps: Deps, sessionID: string, args: string, config: Config): Promise<string> => {
  const { client } = deps
  try {
    const r = await rejectAny(gateCtx(deps, config), args.trim())
    const id = r.ok && r.data.requeued && typeof r.data.id === "string" ? r.data.id : null
    if (!id) return report(client, r.message, gateVariant(r))
    // Chain the re-plan unless this session is mid-loop or the task is taken —
    // the same guards `plan <id>` runs, minus the resolution core already did.
    if (driving.has(sessionID) || getWorkflow(sessionID) || findSessionDriving(id)) {
      return report(client, r.message, gateVariant(r))
    }
    const queued = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", id)
    if (!queued || !(await claimForPlan(deps, sessionID, queued, config))) {
      return report(client, r.message, gateVariant(r)) // raced by a watcher — it re-plans the task there
    }
    return report(client, `Plan rejected for "${queued.title}" — re-planning now… (a revised plan will park in plan-review/ for your gate)`, "info")
  } catch (err) {
    return report(client, `Replan failed: ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `remove <id> [--force]` — hard-delete a task from the backlog entirely.
 * Unlike every other gate this deletes the file rather than moving it: the task
 * leaves the backlog for good, recoverable from git ONLY when the backlog is
 * tracked, which is not the default. Core refuses a task a live loop is driving
 * or one holding a claim marker. An id is required — there is no folder-driven
 * "remove the awaiting one" (too easy to delete the wrong task).
 *
 * Without `--force` core reports what it WOULD delete and deletes nothing. This
 * runs inside `command.execute.before`, so there is no turn in which a model
 * could ask the user first — the dry run is the only confirmation there is. Use
 * `abandon` when the task should merely leave the active backlog.
 *
 * Report-and-stop, like the gates: both arms — the dry run and the forced
 * delete — complete deterministically in core, and the dry run's whole point
 * is that the USER reads which task the id resolved to before confirming. A
 * toast alone is invisible to the model, so the outcome must replace the
 * rendered markdown for the model to relay it; the markdown's remove block
 * survives only when the plugin never ran, and is written as that tripwire.
 */
export const handleRemove = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<string> => {
  const { client } = deps
  const words = args.trim().split(/\s+/).filter(Boolean)
  const force = words.some((w) => w === "--force" || w === "-f")
  const id = words.find((w) => !w.startsWith("-")) ?? ""
  if (!id) return report(client, `Usage: ${ECMD} remove <id> [--force].`, "warning")
  try {
    const r = await removeTask(gateCtx(deps, config), id, force)
    return report(client, r.message, gateVariant(r))
  } catch (err) {
    return report(client, `Remove failed for "${id}": ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `abandon <id> [reason]` — cancel a task by moving it to `abandoned/`.
 * The reversible counterpart to `remove`: the file survives, so unlike `remove`
 * this needs no confirmation. An id is required for the same reason.
 *
 * Report-and-stop, like the other gates: the whole flow — resolve, refuse a
 * live-driven or claim-held task, move to `abandoned/`, release the worktree —
 * is deterministic in core and self-reports a failed move. The returned
 * outcome replaces the rendered markdown; the markdown's abandon block
 * survives only when the plugin never ran, and is written as that tripwire.
 */
export const handleAbandon = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<string> => {
  const { client } = deps
  const [id = "", ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (!id) return report(client, `Usage: ${ECMD} abandon <id> [reason].`, "warning")
  try {
    const r = await abandonTask(gateCtx(deps, config), id, rest.join(" ") || undefined)
    return report(client, r.message, gateVariant(r))
  } catch (err) {
    return report(client, `Abandon failed for "${id}": ${(err as Error).message}`, "error")
  }
}

/**
 * Plan one approved task now (`plan <id>`): claims a `queued/` task and runs
 * the PLAN stage (writes the plan, parks in `plan-review/`, exits). Building
 * is deliberately NOT reachable from here — `claim`/`watch` drive builds — so
 * an `in-progress/` id gets pointed there instead. The drive itself is
 * deferred to the next idle via `setPending`, after atomically claiming.
 */
const startPlanById = async (deps: Deps, sessionID: string, id: string, config: Config): Promise<string | undefined> => {
  const { client } = deps
  // Same busy guard as `claim`: this session may already be driving a
  // DIFFERENT task (watch-claimed) — the unconditional clearWorkflow below would
  // null that run's state and silently abandon it mid-stage.
  if (driving.has(sessionID) || getWorkflow(sessionID)) {
    return report(client, `A loop is already driving in this session — ${ECMD} stop it first.`, "warning")
  }
  // Accept the short-hash handle (`plan f7k3`) the UIs surface as the copyable
  // id — the same resolution the gate verbs do.
  const resolved = await resolveTaskIdAnywhere(deps.$, deps.directory, config.tasksDir, id, deps.log)
  if (resolved && "ambiguous" in resolved) {
    return report(client, `Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`, "warning")
  }
  if (resolved) id = resolved.id
  const queued = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", id)
  if (!queued) {
    const elsewhere = await findAnyStatus(deps, config, id)
    const detail =
      elsewhere === "in-progress"
        ? `its plan is already approved — it's build-ready; ${ECMD} claim (or watch) builds it`
        : elsewhere === "plan-review"
          ? `its plan is parked for review — ${ECMD} approve ${id} (or ${ECMD} replan ${id} <why>)`
          : elsewhere === "draft"
            ? `it's a draft — approve it first with ${ECMD} approve ${id}`
            : elsewhere
              ? `it's in ${elsewhere}`
              : `no task "${id}" found`
    return report(client, `Can't plan "${id}": ${detail}.`, "warning")
  }
  if (findSessionDriving(id)) {
    return report(client, `Task "${id}" is already being driven by a live loop.`, "warning")
  }
  if (!(await claimForPlan(deps, sessionID, queued, config))) {
    return report(client, `Task "${id}" was just claimed by another watcher.`, "warning")
  }
  return report(client, `Loop started on "${queued.title}" — planning… (it will park in plan-review/ for your gate)`, "info")
}

/** Per-kind usage toasts. Engineering carries the full lifecycle; every other
 *  kind gets the minimal watcher verb set. */
const USAGE =
  `Usage: ${ECMD} new <idea> · retask <id> [note] · approve [id] · replan [id] [reason] · ` +
  "abandon <id> [reason] · remove <id> --force · plan <id> · " +
  "claim · watch [interval] · unwatch · recover <id> · kinds · doctor [fix] · stop · status"
const kindUsage = (kind: string): string => `Usage: /agentic-workflow:${kind} claim · watch [interval] · unwatch · stop · status`

/**
 * Parse a `claim <pr>` target into a positive PR number. Accepts a bare number
 * (`42`), a `#`-prefixed number (`#42`), or a PR URL whose last path segment is
 * the number (`https://github.com/o/r/pull/42`). Returns null for anything else.
 * Pure.
 */
export const parsePrTarget = (rest: string): number | null => {
  const s = rest.trim()
  if (!s) return null
  const fromUrl = /\/pull(?:request)?s?\/(\d+)/i.exec(s)
  const digits = fromUrl ? fromUrl[1]! : /^#?(\d+)$/.exec(s)?.[1]
  if (!digits) return null
  const n = Number(digits)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Parse and handle a `/agentic-workflow:<kind> ...` command. Engineering gets the
 *  full backlog lifecycle; every other kind gets the minimal watcher verb set
 *  (claim · watch · unwatch · stop · status), scoped to that kind. */
/**
 * The config files actually in effect, for the `kinds` toast.
 *
 * Worth spelling out because the user-scope layer has three silent ways to miss:
 * only ONE user-scope file is ever read (the two locations are not merged with
 * each other), the two locations use DIFFERENT file names (dotted
 * `~/.agentic-workflow.json` vs undotted `…/agentic-workflow/agentic-workflow.json`),
 * and a path that resolves to a non-existent file just leaves the layer absent.
 * Each looks identical to "the setting I wrote has no effect".
 */
export const configSources = (): string => {
  const user = resolveUserConfigPath()
  if (user === null) return `Config: .agentic-workflow.json (repo) only — the user-scope layer is disabled.`
  const state = fs.existsSync(user) ? "" : " (absent)"
  const ignored = ignoredUserConfigPaths(user)
  const base = `Config: .agentic-workflow.json (repo, wins) over ${user}${state} (user).`
  return ignored.length ? `${base} NOT read: ${ignored.join(", ")} — move those settings into ${user}.` : base
}

export const handleCommand = async (
  deps: Deps,
  sessionID: string,
  args: string,
  config: Config,
  kind: string = "engineering",
): Promise<string | undefined> => {
  const { client } = deps
  const arg = args.trim()
  const { verb, rest } = splitVerb(arg)
  const engineering = kind === "engineering"

  // Engineering-only verbs on another kind's command → that kind's usage.
  if (!engineering && !["claim", "watch", "unwatch", "stop", "abort", "status", ""].includes(verb)) {
    return report(client, `Unknown /agentic-workflow:${kind} mode "${arg}". ${kindUsage(kind)}.`, "warning")
  }

  if (engineering) {
    // `new` returns undefined so the command hook leaves the rendered markdown
    // in place — the interview is the model's turn. `retask` is the hybrid:
    // undefined (interview proceeds) only when its placement half succeeded;
    // its refusals are report-and-stop like the gates. Every other engineering
    // verb is report-and-stop: it returns an outcome string for the hook to
    // surface, because a toast alone is invisible to the model.
    if (verb === "new") return
    if (verb === "retask") return handleRetask(deps, sessionID, rest, config)

    // The deterministic gate verbs: the unified folder-driven approve, replan
    // (the sole rejection verb), remove (dry-run unless --force), and abandon.
    // All report-and-stop — core self-verifies the move/delete, so the outcome
    // replaces the markdown instead of a model turn glob-verifying it.
    if (verb === "approve") return handleApprove(deps, sessionID, rest, config)
    if (verb === "replan") return handleReplan(deps, sessionID, rest, config)
    if (verb === "remove") return handleRemove(deps, sessionID, rest, config)
    if (verb === "abandon") return handleAbandon(deps, sessionID, rest, config)

    // Plan one approved (queued/) task now. Building is claim/watch's job.
    if (verb === "plan") {
      const id = rest
      if (!id) return report(client, `Usage: ${ECMD} plan <id>.`, "warning")
      return startPlanById(deps, sessionID, id, config)
    }

    // List the workflow kinds this clone knows about and which are enabled.
    if (verb === "kinds" && !rest) {
      const enabled = enabledWorkflowKinds(config)
      let known: string[]
      try {
        known = fs
          .readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      } catch {
        known = enabled
      }
      // Every sitter is experimental, and "can I rely on this?" rides along
      // with "is this on?" — so mark them here, where the kind is named,
      // rather than leaving the caveat to the docs.
      const parts = known.map((k) => {
        const state = enabled.includes(k) ? "enabled" : "disabled"
        return EXPERIMENTAL_KINDS.includes(k) ? `${k} (${state}, experimental)` : `${k} (${state})`
      })
      // `kinds` is where someone lands when a kind they enabled reads as
      // disabled, and the usual cause is that the file they edited is not one
      // of the two being read. Naming the actual sources answers that directly.
      return report(client, `Workflow kinds: ${parts.join(" · ")}. Toggle via workflows.<kind>.enabled. ${configSources()}`, "info")
    }
  }

  // One-shot pull: claim the next item of THIS command's kind and drive it
  // once this command's own turn settles — the same idle deferral `plan <id>`
  // gets. The pull equivalent of `watch`.
  if (verb === "claim") {
    if (driving.has(sessionID) || getWorkflow(sessionID)) {
      return report(client, `A loop is already driving in this session — /agentic-workflow:${kind} stop it first.`, "warning")
    }
    // `claim <pr>` forces a specific PR on a PR-shaped kind (pr-sitter /
    // review-sitter), overriding the poller's "what needs attention" heuristic.
    if (rest) {
      const isPrKind = manifestFor(kind).manifest.workSource.type === "pull-request"
      if (!isPrKind) {
        return report(client, `/agentic-workflow:${kind} claim takes no argument — a specific PR number only applies to the PR sitters.`, "warning")
      }
      const target = parsePrTarget(rest)
      if (target === null) {
        return report(client, `Could not read "${rest}" as a PR — pass a number (42), #42, or a PR URL.`, "warning")
      }
      claimRequested.set(sessionID, { kind, target })
      return report(client, `Claiming PR #${target} for ${kind} — it starts when this turn settles.`, "info")
    }
    claimRequested.set(sessionID, { kind })
    return report(client, `Claiming the next ${kind} item — it starts when this turn settles.`, "info")
  }

  if ((verb === "stop" || verb === "abort") && !rest) {
    const wasWatching = await stopWatching(deps, sessionID)
    claimRequested.delete(sessionID) // a queued one-shot claim dies with the stop
    await dropPending(deps, sessionID) // release any queued-but-undriven claim marker
    // Stop the fanned-out passes the user cannot see, exactly as onInterrupt
    // does: they run in their own sessions, so clearing the workflow alone
    // leaves N lens/axis turns burning tokens against a loop the user just
    // killed, their late verdicts racing closePassSession's table cleanup.
    for (const id of passSessions.get(sessionID) ?? []) {
      await client.session.abort({ path: { id } }).catch(() => {})
    }
    const state = getWorkflow(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(
          `Loop stopped by /agentic-workflow:${kind} stop — was at ${state.stage} (iteration ${state.iteration + 1}).`,
          new Date(),
          await gitActor(deps.$, deps.directory),
        ),
        deps.log,
      )
    }
    const existed = clearWorkflow(sessionID)
    const message = existed ? "Loop stopped." : wasWatching ? "Stopped watching." : "No active loop to stop."
    return report(client, message, "info")
  }

  if (verb === "watch") {
    const parsed = parseWatchArgs(rest)
    if ("error" in parsed) return report(client, parsed.error, "warning")
    // The kind's configured trigger (workflows.<kind>.trigger) is the default; any
    // `watch` argument — poll [interval], cron <schedule>, idle, or a bare
    // interval — overrides it for this session only.
    const configured = triggerFor(config, kind)
    const trigger = parsed.trigger ?? configured
    const mode: TriggerMode = trigger.type
    // Only one watcher process per clone: acquire the on-disk lease before
    // arming (a re-arm by an already-watching session keeps its share).
    if (!watching.has(sessionID)) {
      const lease = await acquireWatchLease(deps, config)
      if (!lease.ok) return report(client, lease.message, "warning")
    }
    watching.add(sessionID)
    watchKindFilter.set(sessionID, kind) // the command IS the kind — every tick scopes to it
    stopWatchTimer(sessionID) // replace any prior timer instead of stacking
    let handle: WatchTimerHandle
    if (trigger.type === "cron") {
      // A schedule fire is a one-shot claim: watchTick claims only when the
      // session is actually idle, so a fire landing mid-drive is skipped and
      // the next fire retries. The finally-cleanup keeps a skipped fire's
      // request from leaking into a later plain idle event.
      handle = armCron(trigger.schedule, () => {
        claimRequested.set(sessionID, { kind })
        void watchTick(deps, sessionID, config).finally(() => claimRequested.delete(sessionID))
      })
    } else if (trigger.type === "idle") {
      handle = armIdle() // the session.idle event stream alone drives claims
    } else {
      // Interval resolution: the override's own interval, else the configured
      // poll trigger's, else the host default.
      const overrideMs = "intervalMs" in trigger ? trigger.intervalMs : undefined
      const configuredMin = configured.type === "poll" ? configured.intervalMinutes : undefined
      const intervalMs = Math.max(overrideMs ?? (configuredMin ?? config.watchIntervalMinutes) * 60_000, MIN_WATCH_INTERVAL_MS)
      handle = armPoll(intervalMs, () => void watchTick(deps, sessionID, config))
    }
    watchTimers.set(sessionID, handle)
    watchTriggerMode.set(sessionID, mode)
    lastSkipReason.delete(sessionID) // a fresh arm re-toasts whatever reason comes next
    const scope = engineering ? "approved tasks to plan and build" : `${kind} work`
    const overrideNote =
      parsed.trigger !== undefined && parsed.trigger.type !== configured.type
        ? ` (this session only — config default is ${configured.type})`
        : ""
    const message = `Watching for ${scope} (${handle.describe})${overrideNote}.`
    await toast(client, message, "info")
    // Immediate first pull — don't make the user wait for the next idle event
    // or timer tick. watchTick self-guards: it claims only when the session is
    // actually idle, and never throws. Cron kinds wait for their schedule.
    if (mode !== "cron") void watchTick(deps, sessionID, config)
    return message
  }

  if (verb === "unwatch" && !rest) {
    const was = await stopWatching(deps, sessionID)
    return report(client, was ? "Stopped watching." : "Not watching.", "info")
  }

  if (verb === "recover") {
    let id = rest
    if (!id) return report(client, `Usage: ${ECMD} recover <id>.`, "warning")
    // Same busy guard as `claim`: recovering while this session drives a
    // DIFFERENT task would clearWorkflow that run's state and abandon it mid-stage.
    if (driving.has(sessionID) || getWorkflow(sessionID)) {
      return report(client, `A loop is already driving in this session — ${ECMD} stop it first.`, "warning")
    }
    // Accept the short-hash handle, same as the gate verbs and `plan <id>`.
    const resolved = await resolveTaskIdAnywhere(deps.$, deps.directory, config.tasksDir, id, deps.log)
    if (resolved && "ambiguous" in resolved) {
      return report(client, `Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`, "warning")
    }
    if (resolved) id = resolved.id
    const task = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) return report(client, `No in-progress task "${id}".`, "warning")
    if (findSessionDriving(id)) {
      return report(client, `Task "${id}" is being driven by a live loop — nothing to recover.`, "warning")
    }
    if (isClaimable(task)) {
      return report(client, `Task "${id}" was never started — ${ECMD} watch will claim it.`, "info")
    }
    if (!isRecoverable(task)) {
      return report(client, `Task "${id}" has no persisted plan — send it back with ${ECMD} replan ${id}.`, "warning")
    }
    // Re-claim. A held marker no longer means "leftover from the dead run" —
    // graceful stops/interrupts release it — so a failed claim means either a
    // live loop in another process (fresh stage marker: refuse, or two loops
    // build the same feature/<id> branch) or a hard-crashed run whose writer
    // pid is gone (take the marker over atomically).
    if (!(await claimTask(deps.$, task))) {
      const liveHost = await taskDrivenByStageMarker(deps.$, deps.directory, config.tasksDir, id)
      if (liveHost) {
        return report(
          client,
          `Task "${id}" is being driven by a live ${liveHost} loop (fresh stage marker) — stop that loop first, or wait out its stage deadline.`,
          "warning",
        )
      }
      // A dead stage marker naming the task is crash evidence — take the claim
      // over now. No marker at all is ambiguous: a just-claimed live run spends
      // minutes in its setup window (isolation, stage checks) BEFORE its first
      // marker write, and an unconditional sweep there started a second drive
      // on the same feature/<id> branch. There, only a claim stamp older than
      // the base stale window authorizes the takeover.
      const crashed = await taskNamedByStageMarker(deps.$, deps.directory, config.tasksDir, id)
      if (!(await claimTaskSweepingStale(deps.$, task, crashed ? 0 : STALE_CLAIM_MINUTES))) {
        return report(
          client,
          crashed
            ? `Task "${id}"'s claim marker was just re-taken by another process — nothing to recover.`
            : `Task "${id}"'s claim is less than ${STALE_CLAIM_MINUTES} minutes old and no stage marker exists yet — ` +
                `the claiming run may still be setting up before its first stage. Stop it first, or retry once the claim goes stale.`,
          "warning",
        )
      }
    }
    // Prefer an exact-stage resume from the state snapshot; fall back to
    // re-entering at BUILD from the persisted plan when there's no valid one.
    const snap = await loadState(client, deps.directory, config.tasksDir, id)
    const actor = await gitActor(deps.$, deps.directory)
    clearWorkflow(sessionID)
    if (snap && snap.task?.id === id) {
      // Refresh the task path from disk — the file may have moved since the snapshot.
      const state: WorkflowState = { ...snap, task: { ...snap.task, path: task.path } }
      await appendNote(
        deps.$,
        task,
        auditNote(`Recovered by recover — resuming from snapshot at ${snap.stage}.`, new Date(), actor),
        deps.log,
      )
      await setPending(deps, sessionID, { kind: "recover-state", state })
      return report(
        client,
        `Recovering "${task.title}" from snapshot at ${snap.stage} — check git status/diff for leftovers; resuming…`,
        "info",
      )
    }
    await appendNote(
      deps.$,
      task,
      auditNote("Recovered by recover — resuming BUILD from the persisted plan.", new Date(), actor),
      deps.log,
    )
    await setPending(deps, sessionID, { kind: "recover", task })
    return report(
      client,
      `Recovering "${task.title}" — check git status/diff for leftovers from the interrupted run; building…`,
      "info",
    )
  }

  if (verb === "doctor") {
    const fix = /(^|\s)(--)?fix(\s|$)/.test(rest.toLowerCase())
    try {
      const anomalies = await auditBacklog(client, deps.directory, config.tasksDir)
      const heldQueued = await listClaimIds(deps.$, deps.directory, config.tasksDir, "queued")
      const heldInProgress = await listClaimIds(deps.$, deps.directory, config.tasksDir, "in-progress")
      // A plan request whose task has left queued/ reorders nothing and blocks
      // nothing, but it lingers — name it rather than leave an unexplained marker.
      const queuedNow = await listByStatus(client, deps.directory, config.tasksDir, "queued", deps.log)
      const queuedIds = queuedNow.map((t) => t.id)
      // CONFIRMED strays only: the listing can lag the real FS (and skips
      // unparseable files), and a request written after it — the hub's Plan
      // button, mid-doctor — must never be judged against it.
      const strayRequests = await confirmedStrayPlanRequestIds(deps.$, deps.directory, config.tasksDir, queuedIds, "queued", deps.log)
      for (const line of formatAnomalies(anomalies, config.tasksDir)) await deps.log("warn", `doctor: ${line}`)
      if (heldQueued.length) await deps.log("info", `doctor: claim marker(s) held in queued/.claims: ${heldQueued.join(", ")}`)
      if (heldInProgress.length) await deps.log("info", `doctor: claim marker(s) held in in-progress/.claims: ${heldInProgress.join(", ")}`)
      if (strayRequests.length) {
        await deps.log("info", `doctor: plan request(s) whose task left queued/: ${strayRequests.join(", ")}`)
      }
      const findings =
        formatAnomalies(anomalies, config.tasksDir).length + heldQueued.length + heldInProgress.length + strayRequests.length
      if (!fix) {
        return report(
          client,
          findings
            ? `Backlog doctor: ${findings} finding(s) — see the log. /agentic-workflow:engineering doctor fix applies the unambiguous repairs.`
            : "Backlog doctor: clean.",
          findings ? "warning" : "success",
        )
      }
      // Unambiguous repairs only: rescue strays to draft/, remove now-empty
      // stray folders, release stale orphaned claim markers. Duplicates are a
      // human call — never auto-resolved.
      const actor = await gitActor(deps.$, deps.directory)
      const rescued: string[] = []
      for (const stray of anomalies.strayFiles) {
        try {
          const { id, path: newPath } = await rescueStray(deps.$, deps.directory, config.tasksDir, stray)
          await appendNote(deps.$, { id, path: newPath }, auditNote(`Rescued from ${stray} — was outside every status folder`, new Date(), actor), deps.log)
          rescued.push(stray)
        } catch (err) {
          await deps.log("warn", `doctor: could not rescue ${stray}: ${(err as Error).message}`)
        }
      }
      const removedDirs: string[] = []
      for (const dir of anomalies.unknownDirs) {
        const out = await deps.$`rmdir ${path.join(deps.directory, config.tasksDir, dir)}`.quiet().nothrow()
        if (out.exitCode === 0) removedDirs.push(dir)
      }
      const released: string[] = []
      for (const [status, ids] of [["queued", heldQueued], ["in-progress", heldInProgress]] as const) {
        if (!ids.length) continue
        const tasks = await listByStatus(client, deps.directory, config.tasksDir, status, deps.log)
        released.push(
          ...(await releaseOrphanedClaims(deps.$, tasks, ids, path.join(deps.directory, config.tasksDir, status), {
            isDriving: (id) => findSessionDriving(id) !== undefined,
            staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
            // Doctor releases a stale, undriven marker whatever the body says
            // (`isOrphanedStartedClaim`) — the default rule's `isClaimable`
            // gate made doctor useless against exactly the wedged markers the
            // gate verbs send users here for.
            isOrphaned: status === "queued" ? isOrphanedPlanClaim : isOrphanedStartedClaim,
          })),
        )
      }
      // Unlike a claim, a stray request is never ambiguous: its task has left
      // the folder, so nothing can be driving it. No liveness check, and no
      // commit — the markers were never tracked. Only the CONFIRMED strays
      // from above are revoked; a request written since (the hub's Plan
      // button racing this doctor) is left alone.
      const revokedRequests = await revokeStrayPlanRequests(deps.$, deps.directory, config.tasksDir, strayRequests)
      if (rescued.length) {
        await commitTasks(deps, config, `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
      }
      const summary = [
        rescued.length ? `rescued ${rescued.length} stray file(s) to draft/` : "",
        removedDirs.length ? `removed ${removedDirs.length} stray folder(s)` : "",
        released.length ? `released ${released.length} stale claim marker(s)` : "",
        revokedRequests.length ? `dropped ${revokedRequests.length} stray plan request(s)` : "",
        anomalies.duplicates.length ? `${anomalies.duplicates.length} duplicate id(s) left for you` : "",
      ].filter(Boolean)
      return report(client, summary.length ? `Backlog doctor: ${summary.join(" · ")}.` : "Backlog doctor: nothing to repair.", "success")
    } catch (err) {
      return report(client, `Backlog doctor failed: ${(err as Error).message}`, "error")
    }
  }

  if ((verb === "status" && !rest) || verb === "") {
    const isWatching = watching.has(sessionID)
    const state = getWorkflow(sessionID)
    // Backlog roll-up accompanies the session-loop line — a whole-backlog view,
    // not just this session's loop (engineering only: other kinds have no
    // backlog folders). Detailed flag lists go to the log.
    const summary = engineering ? await backlogSummary(deps, config).catch(() => null) : null
    if (summary) {
      if (summary.interrupted.length) {
        await deps.log("warn", `interrupted (run ${ECMD} recover <id>): ${summary.interrupted.join(", ")}`)
      }
      if (summary.awaitingReview.length) {
        await deps.log("info", `awaiting diff review (run ${ECMD} approve <id>): ${summary.awaitingReview.join(", ")}`)
      }
    }
    const backlogLine = summary ? ` · ${formatBacklog(summary)}` : ""
    const enabled = enabledWorkflowKinds(config)
    const kindsLine = engineering && enabled.length > 1 ? ` · kinds: ${enabled.join(", ")}` : ""
    const cadence = watchTimers.get(sessionID)?.describe
    const kindScope = watchKindFilter.get(sessionID)
    const watchLabel = cadence ? `Watching${kindScope ? ` ${kindScope}` : ""} (${cadence})` : "Watching"
    if (!state) {
      // Prefer the remembered skip reason over a bare "no claimable task" —
      // it says WHY the watcher isn't picking anything up.
      const why = lastSkipReason.get(sessionID)
      const idle = engineering ? "no claimable task right now." : `no claimable ${kind} item right now.`
      const head = isWatching ? `${watchLabel} — ${why ?? idle}` : "No active loop."
      return report(client, `${head}${backlogLine}${kindsLine}`, "info")
    }
    const what = state.task ? `task ${state.task.id}` : state.goal
    const prefix = isWatching ? `${watchLabel}. ` : ""
    return report(client, `${prefix}Loop: ${state.stage} · iteration ${state.iteration + 1} · ${what}${backlogLine}${kindsLine}`, "info")
  }

  // The loop is a pure executor — there is no free-text mode. Anything
  // unrecognized gets usage help instead of silently becoming a goal.
  return report(client, `Unknown /agentic-workflow:${kind} mode "${arg}". ${engineering ? USAGE : kindUsage(kind)}.`, "warning")
}
