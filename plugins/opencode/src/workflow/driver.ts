import type { PluginInput } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@agentic-workflow/core/fsatomic"
import { type Task } from "@agentic-workflow/core/task/schema"
import { advance, composePrompt, firstStep } from "@agentic-workflow/core/workflow/engine"
import {
  clearOpencodeStageMarker,
  opencodeStageMarker,
  writeOpencodeStageMarker,
} from "@agentic-workflow/core/workflow/stage-marker"
import { registerEngineeringHooks } from "@agentic-workflow/core/kinds/engineering"
import { defaultWorkflowsDir } from "@agentic-workflow/core/manifest/dir"
import { stageDef, type LoadedManifest } from "@agentic-workflow/core/manifest/schema"
import { combineSkips, pollOnce } from "@agentic-workflow/core/scheduler/scheduler"
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
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedPlanClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  listInProgress,
  listQueued,
  markClaimed,
  moveTask,
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
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import { acquireLease, heartbeatLease, releaseLease } from "@agentic-workflow/core/scheduler/lease"
import {
  addWorktree,
  checkoutBranch,
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
import { clearState, loadState, saveState } from "@agentic-workflow/core/workflow/persist"
import { approveAny, rejectAny, removeTask, retaskTask, type GateCtx } from "@agentic-workflow/core/workflow/gate"
import { runTerminal, type TerminalCtx } from "@agentic-workflow/core/workflow/terminal"
import { type Outcome, renderRunSummary, type StageSample, type StageTokens, type StageToolUsage } from "@agentic-workflow/core/workflow/metrics"
import { metricsPath, upsertRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import {
  admitVerdict,
  effectiveVerdict,
  mergeAxes,
  verdictFeedbackBlock,
  WORKFLOW_REVIEW_TAG,
  WORKFLOW_VERIFY_TAG,
  parseVerdict,
  stageDriftNote,
  type AxisResult,
  type Verdict,
  type VerdictRecord,
  worstOf,
} from "@agentic-workflow/core/workflow/verdict"
import {
  enabledWorkflowKinds,
  ignoredUserConfigPaths,
  modelFor,
  resolveUserConfigPath,
  triggerFor,
  deprecatedAdoKeys,
  unknownStageModelKeys,
  unreviewedAxes,
} from "@agentic-workflow/core/config"
import type { Config } from "../config.ts"
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
 * PLAN runs only on demand (`plan <id>`); BUILD → VERIFY → REVIEW runs on
 * demand (a claim) or via **watch mode** (the `watching` set + `tryClaim`): a
 * watching session scans `in-progress/` for one claimable task (`isClaimable`:
 * has a persisted plan, never started). `queued/` is a manual pool — claim and
 * watch never auto-plan from it. Watch is triggered two ways — every
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
 *  An `only` kind restricts the poll to that one kind (claim/watch kind filter). */
const sourcesFor = (deps: Deps, config: Config, only?: string): WorkSource[] =>
  buildWorkSources({ ...deps, isDriving: (id) => findSessionDriving(id) !== undefined }, config, manifestFor, only)

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
 * same deferral `task <id>` gets via `pending`. The value is the kind filter
 * (undefined = all enabled kinds).
 */
const claimRequested = new Map<string, string | undefined>()
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
 * Axes the running check stage's verdict must cover, per driving session.
 *
 * Published by `runStageWithLenses` rather than read from the manifest inside
 * `recordVerdict`, because a lens pass is told to "focus exclusively on
 * <lens>" — enforcing all five axes on it would reject every pass and deadlock
 * the loop. Lens mode therefore clears the requirement; it already enforces its
 * own coverage by turning a lens that recorded nothing into a synthetic ERROR.
 */
const axisRequirement = new Map<string, readonly string[]>()

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
  const admission = admitVerdict(record, axisRequirement.get(sessionID), prev?.stage === stage ? prev.record : null)
  if (!admission.ok) return reject(admission.message)
  recordedVerdicts.set(sessionID, { stage, record: admission.record })
  return { accepted: true, message: `Recorded ${stage} verdict: ${effectiveVerdict(admission.record)}.` }
}

/** Consume (read-and-clear) the verdict record for a session's check stage, if any. */
const takeVerdictRecord = (sessionID: string, stage: CheckStage): VerdictRecord | null => {
  const rec = recordedVerdicts.get(sessionID)
  recordedVerdicts.delete(sessionID)
  return rec && rec.stage === stage ? rec.record : null
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
 * Serialize commits per git tree. In worktree mode `serialize` is off, so N in-process
 * watch drives run concurrently — and a command handler can fire mid-drive in either
 * mode — all committing the MAIN tree. Concurrent `git commit`s contend on
 * `.git/index.lock`; the loser's `commitPaths`/`commitAll` hits `.nothrow()`, returns
 * false, and the change never enters history (the fs task-move still lands, so it looks
 * committed). A per-tree promise chain makes each tree's commits run one at a time.
 * Keyed by tree path: a worktree's own index never contends with the main tree's.
 */
const commitLocks = new Map<string, Promise<unknown>>()
const withCommitLock = <T>(treePath: string, fn: () => Promise<T>): Promise<T> => {
  const prev = commitLocks.get(treePath) ?? Promise.resolve()
  const run = prev.then(fn, fn) // run regardless of the prior commit's outcome
  commitLocks.set(
    treePath,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

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
  const excludes = state.git?.worktree ? [config.tasksDir] : undefined
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
    if (r.verdict === "PASS") return
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
 * its verdict record. REVIEW expands into one pass per configured lens — the
 * verdicts are combined worst-wins and non-PASS pass outputs concatenated, so
 * a single injected reviewer can't flip the outcome (threat model T1). All
 * other stages run exactly once. Stops firing further lens passes if a
 * `stop` clears the loop mid-pass. Exported for tests.
 */
export const runStageWithLenses = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  loaded: LoadedManifest,
  state: WorkflowState,
  stage: Stage,
  baseArgs: string,
  iteration: number,
): Promise<{ output: string; verdict: Verdict | null; record: VerdictRecord | null }> => {
  const isCheck = stageDef(loaded.manifest, stage).kind === "check"
  const model = modelFor(config, loaded.manifest.kind, stageDef(loaded.manifest, stage))
  const lenses = stage === "review" ? config.reviewLenses : []
  const passes: (string | null)[] = lenses.length ? [...lenses] : [null]
  // Axis coverage is enforced only when this stage runs as ONE pass. A lens
  // pass is told to focus exclusively on its own lens, so demanding every axis
  // from it would reject every pass and wedge the loop; lens mode gets its
  // coverage from the per-lens ERROR fallback below instead.
  const required = stageDef(loaded.manifest, stage).requiredAxes
  if (required?.length && !lenses.length) axisRequirement.set(sessionID, required)
  else axisRequirement.delete(sessionID)
  const outputs: string[] = []
  const records: (VerdictRecord | null)[] = []
  const { client } = deps

  for (let i = 0; i < passes.length; i++) {
    const lens = passes[i]
    const args = lens
      ? `${baseArgs}\n\nReview lens ${i + 1}/${passes.length}: focus exclusively on ${lens}. The other lenses ` +
        `run as separate passes — don't repeat them. Record this pass's verdict via workflow_verdict as usual.`
      : baseArgs
    // One pass, plus at most one retry when a check stage ends with no
    // workflow_verdict call — a broken verdict channel is not a genuine FAIL, and
    // burning a build iteration on it re-built already-done work (the
    // theater-booking-0 failure mode; parity with the Claude host's retry).
    let passRecord: VerdictRecord | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const passArgs =
        attempt === 0
          ? args
          : `${args}\n\nPREVIOUS ATTEMPT RECORDED NO VERDICT — the workflow_verdict tool call is MANDATORY. ` +
            `If the tool is not in your tool list, state that explicitly in your final message and finish.`
      recordedVerdicts.delete(sessionID) // no stale verdict may leak into this pass
      driftNoted.delete(sessionID) // one drift note per stage attempt, not per run
      const t0 = Date.now()
      const { text: out, usage, activity } = await runStage(
        client,
        sessionID,
        stageCommand(loaded, stage),
        passArgs,
        config.stageTimeoutMinutes,
        model,
      )
      const ms = Date.now() - t0
      const stamp = new Date().toISOString()
      const retryTag = attempt > 0 ? " · verdict retry" : ""
      const header = lens
        ? `${stage} (lens: ${lens}) · iteration ${iteration + 1}${retryTag} · ${stamp}`
        : `${stage} · iteration ${iteration + 1}${retryTag} · ${stamp}`
      await appendRunLog(deps.$, deps.directory, config.tasksDir, workflowId(state), header, out, deps.log)
      outputs.push(lens ? `### Review lens: ${lens}\n${out}` : out)
      passRecord = isCheck ? takeVerdictRecord(sessionID, stage as CheckStage) : null
      addSample(sessionID, {
        stage,
        iteration,
        ms,
        ...(isCheck ? { verdict: passRecord?.verdict ?? "none" } : {}),
        ...(lens ? { lens } : {}),
        startedAt: new Date(t0).toISOString(),
        ...(usage ? { tokens: usage.tokens, cost: usage.cost, model: usage.model } : {}),
        ...(activity ? { tools: activity.tools, ...(activity.files ? { files: activity.files } : {}) } : {}),
      })
      // Publish samples-so-far live (awaited: no flush I/O may be in flight when a
      // terminal event finalizes the sidecar).
      await flushMetrics(deps, sessionID, config, state)
      if (!isCheck || passRecord || halted(sessionID)) break
      if (attempt === 0) {
        await deps.log("warn", `${stage}${lens ? ` (${lens})` : ""} recorded no verdict via workflow_verdict — re-running the pass once`)
      }
    }
    records.push(passRecord)
    if (halted(sessionID)) break // stop or ESC mid-pass — don't fire the rest
  }

  if (!isCheck) return { output: outputs[0] ?? "", verdict: null, record: null }

  // A deliberate stop or an ESC interrupt mid-pass: records may be short and/or
  // end in null. The caller discards the result once halted — return quietly,
  // never routing it through the ERROR path below, which would report an
  // unreachable verdict channel for a stage the user simply stopped.
  if (halted(sessionID)) return { output: outputs.join("\n\n"), verdict: null, record: null }

  // Lenses that FIRED but recorded nothing even after their retry. A missing
  // lens verdict is a broken channel, not a FAIL: worst-wins combining would
  // read it as FAIL and burn a rebuild iteration on possibly-done work, so it
  // must take the same ERROR→recoverable-stop path as the single-pass case —
  // even when another lens recorded a genuine FAIL (a rebuild on partial
  // information is still wasted; the FAIL's output survives in the run log).
  const missingLenses = lenses.filter((_, i) => i < records.length && records[i] === null)
  const record = lenses.length
    ? missingLenses.length
      ? null
      : combineRecords(records, lenses)
    : (records[0] ?? null)
  // The DERIVED verdict — a pass that declared PASS while flagging a Critical
  // finding on an axis fails the stage (verdict.ts `effectiveVerdict`).
  const verdict = record ? effectiveVerdict(record) : null
  axisRequirement.delete(sessionID) // the stage is over; nothing may inherit its requirement
  if (verdict === null) {
    // Still nothing after the retry: the verdict channel is unreachable —
    // surface it as a retryable ERROR (manifest onError → recoverable stop),
    // never as a FAIL that triggers a pointless rebuild.
    const inText = parseVerdict(outputs.join("\n"), stage === "verify" ? WORKFLOW_VERIFY_TAG : WORKFLOW_REVIEW_TAG)
    const lensTag = missingLenses.length ? ` (lens${missingLenses.length > 1 ? "es" : ""}: ${missingLenses.join(", ")})` : ""
    await deps.log(
      "warn",
      `${stage} recorded no verdict via workflow_verdict even after a retry${lensTag}${inText ? ` (text claimed ${inText}, ignored — free text is untrusted)` : ""} — stopping with ERROR`,
    )
    const errorRecord: VerdictRecord = {
      verdict: "ERROR",
      reason:
        `no workflow_verdict recorded even after a retry${lensTag} — the verdict channel is unreachable from the stage subagent ` +
        "or the agent contract was not applied; fix the plugin wiring, then recover the task" +
        (inText ? ` (prose claimed ${inText}, ignored — free text is untrusted)` : ""),
    }
    return { output: outputs.join("\n\n"), verdict: "ERROR", record: errorRecord }
  }
  return { output: outputs.join("\n\n"), verdict, record }
}

/**
 * Persist a task-driven loop's state after a transition, so a crash/restart can
 * resume at the exact stage. No-op for free-text loops (no durable id yet).
 */
const snapshot = async (deps: Deps, config: Config, state: WorkflowState): Promise<void> => {
  if (!state.task) return
  await saveState(deps.$, deps.directory, config.tasksDir, state.task.id, state)
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
): Promise<void> => {
  const samples = runSamples.get(sessionID) ?? []
  runSamples.delete(sessionID)
  driftNoted.delete(sessionID) // the run is over — nothing left to dedupe against
  // Report against the EFFECTIVE cap the engine enforced — a kind's manifest may
  // override `config.maxIterations` (pr-sitter caps at 3), so `config.maxIterations`
  // alone would mislabel the footer (e.g. "iterations used: 3/1").
  const cap = manifestFor(state.kind ?? "engineering").manifest.maxIterations ?? config.maxIterations
  const stamp = new Date().toISOString()
  const summary = renderRunSummary(samples, outcome, detail, cap, stamp)
  await appendRunLog(deps.$, deps.directory, config.tasksDir, workflowId(state), `run · ${outcome}`, summary, deps.log)
  // Structured twin of the summary table — the machine-readable record token
  // dashboards join against. sessionID lets host storage be joined exactly.
  const file = metricsPath(deps.directory, config.tasksDir, workflowId(state))
  const existing = await deps.$`cat ${file}`.quiet().nothrow()
  // Upsert (not append): replace the trailing `open` entry that the per-stage
  // flush left behind — appending here would double-count the run.
  const doc = upsertRunMetrics(existing.exitCode === 0 ? existing.stdout.toString() : null, {
    endedAt: stamp,
    outcome,
    detail,
    host: "opencode",
    sessionID,
    samples,
  })
  await writeFileAtomic(deps.$, file, doc)
}

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop.
 *  Returns the terminal outcome so callers can report it to the work source. */
export const drive = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: WorkflowState; action: Action },
): Promise<TerminalOutcome | null> => {
  try {
    return await driveChain(deps, sessionID, config, first)
  } finally {
    // The chain advertises each live stage on disk (see the write below); every
    // exit — terminal, stop, interrupt, or a thrown stage error unwinding to
    // onIdle's catch — must take the advertisement down with it.
    await clearOpencodeStageMarker(deps.$, deps.directory, config.tasksDir)
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
  // Azure DevOps is now reached only through the az CLI, so ado.access and the
  // raw-fetch-only customHeaders/insecureSkipTlsVerify are inert — name any
  // that are still set rather than ignore them silently.
  const deadAdo = deprecatedAdoKeys(config)
  if (deadAdo.length) {
    await deps.log(
      "warn",
      `${deadAdo.join(", ")} ${deadAdo.length > 1 ? "are" : "is"} no longer supported — Azure DevOps is reached only ` +
        `through the az CLI (azure-devops extension, AZURE_DEVOPS_EXT_PAT). ${deadAdo.length > 1 ? "They are" : "It is"} ` +
        `ignored; remove ${deadAdo.length > 1 ? "them" : "it"} from .agentic-workflow.json. For a self-signed Azure DevOps ` +
        `Server, configure the CLI's own trust (REQUESTS_CA_BUNDLE / \`az devops configure\`) instead.`,
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
  // reviewLenses suppresses per-pass axis-coverage enforcement, so turning it on
  // silently downgrades what a review guarantees — name the axes no lens covers.
  for (const def of loaded.manifest.stages) {
    const unreviewed = unreviewedAxes(config, def)
    if (!unreviewed.length) continue
    await deps.log(
      "warn",
      `reviewLenses is on, so the ${def.name} stage no longer enforces axis coverage, and no lens covers ` +
        `${unreviewed.map((a) => `"${a}"`).join(", ")}. Add ${unreviewed.length > 1 ? "those lenses" : "that lens"} or unset reviewLenses.`,
    )
  }
  const actor = await gitActor(deps.$, deps.directory)
  let step = first
  while (step.action.kind === "fire") {
    const { stage, arguments: args } = step.action
    // Every code-writing stage runs isolated: its own worktree (worktree mode)
    // or the feature/<id> branch in the shared tree (default). Created on the
    // first build; reconciled before every stage in case the tree/worktree
    // moved — including a snapshot-based `recover` that re-enters
    // directly at verify/review, where isolation must be re-established, not
    // assumed. PLAN is the exception: it writes only the task file (in the
    // main tree, on the human's branch) and parks, so it needs no branch, no
    // worktree, and no crash snapshot — a died PLAN is recovered by the stale
    // claim-marker sweep, not by recover.
    const isolated = stageDef(loaded.manifest, stage).isolation !== "none"
    if (isolated) {
      step = { ...step, state: await ensureIsolation(deps, config, step.state) }
    }
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
      opencodeStageMarker(step.state, Date.now() + config.stageTimeoutMinutes * 60_000),
    )
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
    const { output, verdict, record } = await runStageWithLenses(
      deps,
      sessionID,
      config,
      loaded,
      step.state,
      stage,
      args,
      iteration,
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
      await renderMetrics(deps, sessionID, config, step.state, "stopped", `${how} during ${stage}`)
      await checkpoint(deps, config, step.state, `loop(${workflowId(step.state)}): incomplete — ${how} during ${stage}`)
      await teardownIsolation(deps, step.state)
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
    // Thread the machine-recorded failure reasons ahead of the stage's prose so
    // the next PLAN/BUILD iteration leads with what actually failed.
    const block = verdictFeedbackBlock(record)
    const threaded = block ? `${block}\n\n${output}` : output
    // Interpret transitions against the CLAIMED kind's manifest — `loaded`, not
    // the hardcoded engineering `eng`. A pr-sitter loop (stages triage/fix/
    // verify/publish) would otherwise crash on its first transition, as
    // `stageDef(eng.manifest, "triage")` throws. For engineering, `loaded` IS
    // `eng` (same map entry), so this is byte-identical there.
    step = advance(loaded, step.state, config, threaded, verdict)
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
    writeMetrics: (outcome, detail) => renderMetrics(deps, sessionID, config, state, outcome, detail),
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
 * A `watch` session's own idle check: a claimable task in `in-progress/`
 * (plan approved, never started) is driven straight through
 * BUILD → VERIFY → REVIEW. `queued/` is a manual pool — never auto-claimed;
 * a planless task waits there until a human runs `plan <id>` (the skip
 * reason points at it).
 * FAIL-driven re-builds happen inline in this same session, exactly like a
 * normal loop's iteration cap. Never silent: when nothing is claimed, the
 * reason is always logged, and toasted when actionable (deduped until the
 * reason changes).
 */
const tryClaim = async (deps: Deps, sessionID: string, config: Config, only?: string): Promise<void> => {
  const kindFilter = only ?? watchKindFilter.get(sessionID)
  const { claim, skips } = await pollOnce(sourcesFor(deps, config, kindFilter))
  if (!claim) {
    const reason = combineSkips(skips)
    if (!reason) return
    await deps.log(reason.actionable ? "warn" : "info", reason.message)
    if (reason.actionable && lastSkipReason.get(sessionID) !== reason.message) {
      lastSkipReason.set(sessionID, reason.message)
      await toast(deps.client, reason.message, "warning")
    }
    return
  }
  lastSkipReason.delete(sessionID)
  const { item } = claim
  await toast(deps.client, item.claimMessage, "info")
  // Task-backed claims entering an isolated stage get the durable CLAIMED note
  // before drive() establishes isolation.
  if (item.state.task && stageDef(manifestFor(item.workflowKind).manifest, item.state.stage).isolation !== "none") {
    await markClaimedOnHumanBranch(deps, config, item.state.task)
  }
  try {
    const outcome = await drive(deps, sessionID, config, firstStep(manifestFor(item.workflowKind), item.state))
    if (outcome && claim.source.onTerminal) await claim.source.onTerminal(item, outcome)
  } catch (err) {
    // Died before real work started (e.g. ensureIsolation threw, before
    // setWorkflow ran — onIdle's catch can't see the task): the claim is ours, so
    // release it or watch stays wedged. The source knows what "real work"
    // means per pool (a BUILD-started note keeps the marker for recovery).
    await claim.source.release(item)
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
      await drive(deps, sessionID, config, firstStep(eng, buildEntryState(work.task)))
    } else if (work?.kind === "start-plan") {
      // A `plan <id>` / a claim claim on a queued (planless) task: run the PLAN
      // stage, which writes the plan and parks the task in plan-review/.
      await drive(deps, sessionID, config, firstStep(eng, planEntryState(work.task)))
    } else if (work?.kind === "recover-state") {
      // A snapshot-based resume: re-enter at the exact stage the crash caught,
      // with artifacts intact, re-firing that stage from its own inputs.
      await drive(deps, sessionID, config, firstStep(eng, work.state))
    } else {
      // No pending work — a watch session (or one-shot `claim`)
      // with nothing to resume; look for one claimable item across the
      // enabled workflow kinds.
      const only = claimRequested.get(sessionID)
      claimRequested.delete(sessionID)
      await tryClaim(deps, sessionID, config, only)
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
    // A claim that died before its first "> BUILD started" note leaves the
    // task body claimable but the marker held — release it so no watcher is
    // wedged on it forever. (For `recover`, the body already carries BUILD
    // notes, so `isClaimable` is false and this is a no-op.)
    if (work?.kind === "start-task" || work?.kind === "recover") {
      const fresh = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", work.task.id)
      if (fresh && isClaimable(fresh)) await releaseClaim(deps.$, work.task)
    }
    // A PLAN claim that died leaves the task in queued/ with the marker held.
    if (work?.kind === "start-plan") {
      const fresh = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", work.task.id)
      if (fresh) await releaseClaim(deps.$, work.task)
    }
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
 */
export const handleApprove = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const id = args.trim().split(/\s+/).filter(Boolean)[0] ?? ""
  try {
    const r = await approveAny(gateCtx(deps, config), id)
    await toast(client, r.message, r.ok ? "success" : (r.variant ?? "warning"))
  } catch (err) {
    await toast(client, `Approve failed${id ? ` for "${id}"` : ""}: ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `replan [id] [reason]` — the sole rejection verb. Sends a parked plan
 * back to `queued/` for re-planning. Auto-targets the single `plan-review/`
 * task; an explicit id may also name an `in-progress/` (cap-tripped) task.
 * When no leading token names a rejectable task, the whole argument is treated
 * as the reason and the single plan-review task is chosen.
 */
/**
 * Handle `retask <id>` — the deterministic half of the authoring verb. The
 * interview and the rewrite are the agent's work, but WHERE the task must sit
 * before that is the plugin's: a `queued/` task is moved back to `draft/` (its
 * approval withdrawn), a `draft/` task is already right, and a planned task is
 * refused with a pointer at `replan`.
 *
 * The turn is NOT blocked either way — the command template's interview has to
 * run. It doesn't need blocking: after a refusal the file is not in `draft/`, so
 * the agent's own "resolve in draft/ only" step fails and it refuses too.
 */
export const handleRetask = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const id = args.trim().split(/\s+/).filter(Boolean)[0] ?? ""
  if (!id) return void (await toast(client, `Usage: ${ECMD} retask <id> [note].`, "warning"))
  try {
    const r = await retaskTask(gateCtx(deps, config), id)
    // Success is silent unless the plugin actually moved something — the agent's
    // turn reports the reshape, and a toast per retask would double up.
    if (!r.ok) await toast(client, r.message, r.variant ?? "warning")
    else if (!r.data?.alreadyDone) await toast(client, r.message, "success")
  } catch (err) {
    await toast(client, `Retask failed for "${id}": ${(err as Error).message}`, "error")
  }
}

export const handleReplan = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  try {
    const r = await rejectAny(gateCtx(deps, config), args.trim())
    await toast(client, r.message, r.ok ? "success" : (r.variant ?? "warning"))
  } catch (err) {
    await toast(client, `Replan failed: ${(err as Error).message}`, "error")
  }
}

/**
 * Handle `remove <id>` — hard-delete a task from the backlog entirely. Unlike
 * every other gate this deletes the file rather than moving it: the task leaves
 * the backlog for good (git history retains it if the backlog is tracked). Core
 * refuses a task a live loop is driving or one holding a claim marker. An id is
 * required — there is no folder-driven "remove the awaiting one" (too easy to
 * delete the wrong task).
 */
export const handleRemove = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const id = args.trim().split(/\s+/).filter(Boolean)[0] ?? ""
  if (!id) return void (await toast(client, `Usage: ${ECMD} remove <id>.`, "warning"))
  try {
    const r = await removeTask(gateCtx(deps, config), id)
    await toast(client, r.message, r.ok ? "success" : (r.variant ?? "warning"))
  } catch (err) {
    await toast(client, `Remove failed for "${id}": ${(err as Error).message}`, "error")
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
  if (!(await claimTask(deps.$, queued))) {
    return report(client, `Task "${id}" was just claimed by another watcher.`, "warning")
  }
  clearWorkflow(sessionID)
  await setPending(deps, sessionID, { kind: "start-plan", task: queued, goal: taskGoal(queued) })
  return report(client, `Loop started on "${queued.title}" — planning… (it will park in plan-review/ for your gate)`, "info")
}

/** Per-kind usage toasts. Engineering carries the full lifecycle; every other
 *  kind gets the minimal watcher verb set. */
const USAGE =
  `Usage: ${ECMD} new <idea> · retask <id> [note] · approve [id] · replan [id] [reason] · plan <id> · ` +
  "claim · watch [interval] · unwatch · recover <id> · kinds · doctor [fix] · stop · status"
const kindUsage = (kind: string): string => `Usage: /agentic-workflow:${kind} claim · watch [interval] · unwatch · stop · status`

/** Split a command argument into its verb (lowercased) and the remainder. Pure. */
const splitVerb = (arg: string): { verb: string; rest: string } => {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(arg)
  return m ? { verb: m[1]!.toLowerCase(), rest: m[2]!.trim() } : { verb: "", rest: "" }
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
  const lower = arg.toLowerCase()
  const { verb, rest } = splitVerb(arg)
  const engineering = kind === "engineering"

  // Engineering-only verbs on another kind's command → that kind's usage.
  if (!engineering && !["claim", "watch", "unwatch", "stop", "abort", "status", ""].includes(verb)) {
    return report(client, `Unknown /agentic-workflow:${kind} mode "${arg}". ${kindUsage(kind)}.`, "warning")
  }

  if (engineering) {
    // `new`/`retask`/`approve`/`replan`/`remove` return undefined so the command
    // hook leaves the rendered markdown in place: `new`/`retask` need the model's
    // turn (interview), and the gate/remove verbs already have a working
    // markdown-driven flow (approve/replan glob-verify the folder move). Only
    // the report-and-stop verbs below return an outcome string for the hook to
    // surface — a toast alone is invisible to the model.
    if (verb === "new") return
    if (verb === "retask") return void (await handleRetask(deps, sessionID, rest, config))

    // The two deterministic gate verbs: the unified folder-driven approve, and
    // replan (the sole rejection verb). Both parse the post-verb remainder.
    if (verb === "approve") return void (await handleApprove(deps, sessionID, rest, config))
    if (verb === "replan") return void (await handleReplan(deps, sessionID, rest, config))
    if (verb === "remove") return void (await handleRemove(deps, sessionID, rest, config))

    // Plan one approved (queued/) task now. Building is claim/watch's job.
    if (verb === "plan") {
      const id = rest
      if (!id) return report(client, `Usage: ${ECMD} plan <id>.`, "warning")
      return startPlanById(deps, sessionID, id, config)
    }

    // List the workflow kinds this clone knows about and which are enabled.
    if (lower === "kinds") {
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
      const parts = known.map((k) => (enabled.includes(k) ? `${k} (enabled)` : `${k} (disabled)`))
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
    claimRequested.set(sessionID, kind)
    return report(client, `Claiming the next ${kind} item — it starts when this turn settles.`, "info")
  }

  if (lower === "stop" || lower === "abort") {
    const wasWatching = await stopWatching(deps, sessionID)
    claimRequested.delete(sessionID) // a queued one-shot claim dies with the stop
    await dropPending(deps, sessionID) // release any queued-but-undriven claim marker
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

  if (lower === "watch" || lower.startsWith("watch ")) {
    const parsed = parseWatchArgs(arg.slice("watch".length))
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
        claimRequested.set(sessionID, kind)
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

  if (lower === "unwatch") {
    const was = await stopWatching(deps, sessionID)
    return report(client, was ? "Stopped watching." : "Not watching.", "info")
  }

  if (lower === "recover" || lower.startsWith("recover ")) {
    let id = arg.slice("recover".length).trim()
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
    await claimTask(deps.$, task) // re-mark; the marker may already exist from the dead run
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

  if (lower === "doctor" || lower.startsWith("doctor ")) {
    const fix = /(^|\s)(--)?fix(\s|$)/.test(lower.slice("doctor".length))
    try {
      const anomalies = await auditBacklog(client, deps.directory, config.tasksDir)
      const heldQueued = await listClaimIds(deps.$, deps.directory, config.tasksDir, "queued")
      const heldInProgress = await listClaimIds(deps.$, deps.directory, config.tasksDir, "in-progress")
      for (const line of formatAnomalies(anomalies, config.tasksDir)) await deps.log("warn", `doctor: ${line}`)
      if (heldQueued.length) await deps.log("info", `doctor: claim marker(s) held in queued/.claims: ${heldQueued.join(", ")}`)
      if (heldInProgress.length) await deps.log("info", `doctor: claim marker(s) held in in-progress/.claims: ${heldInProgress.join(", ")}`)
      const findings = formatAnomalies(anomalies, config.tasksDir).length + heldQueued.length + heldInProgress.length
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
            ...(status === "queued" ? { isOrphaned: isOrphanedPlanClaim } : {}),
          })),
        )
      }
      if (rescued.length) {
        await commitTasks(deps, config, `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
      }
      const summary = [
        rescued.length ? `rescued ${rescued.length} stray file(s) to draft/` : "",
        removedDirs.length ? `removed ${removedDirs.length} stray folder(s)` : "",
        released.length ? `released ${released.length} stale claim marker(s)` : "",
        anomalies.duplicates.length ? `${anomalies.duplicates.length} duplicate id(s) left for you` : "",
      ].filter(Boolean)
      return report(client, summary.length ? `Backlog doctor: ${summary.join(" · ")}.` : "Backlog doctor: nothing to repair.", "success")
    } catch (err) {
      return report(client, `Backlog doctor failed: ${(err as Error).message}`, "error")
    }
  }

  if (lower === "status" || lower === "") {
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
