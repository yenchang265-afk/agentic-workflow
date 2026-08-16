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
import { stageDef, stageRequiresCriteria, type LoadedManifest } from "@agentic-workflow/core/manifest/schema"
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
  rivalHoldsCurrentBranchLock,
  workflowId,
  teardownIsolation as coreTeardownIsolation,
} from "@agentic-workflow/core/workflow/isolate"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimFirst,
  claimTask,
  claimTaskSweepingDeadWriter,
  claimTaskSweepingStale,
  claimWriterDead,
  claimWriterState,
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
import { abandonTask, approveAny, rejectAny, removeTask, retaskTask, type GateCandidate, type GateCtx, type GateResult } from "@agentic-workflow/core/workflow/gate"
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
  stageDriftRefusal,
  uncoveredAxes,
  withCoverageGap,
  type AxisResult,
  type CriteriaContext,
  type RejectedVerdict,
  type StagePass,
  type Verdict,
  type VerdictRecord,
  worstOf,
} from "@agentic-workflow/core/workflow/verdict"
import { NO_OBSERVATIONS, type EvidenceContext, type ObservedEvidence } from "@agentic-workflow/core/workflow/evidence"
import { checkCommands, checksBudgetMs, finalizeCheckRecord, runChecks } from "@agentic-workflow/core/workflow/checks"
import { checksProvenanceNote, clampedChecksDetail, hasChecksFence, resolveStageChecks, type ChecksSource } from "@agentic-workflow/core/workflow/discovered-checks"
import {
  EXPERIMENTAL_KINDS,
  concurrencyFor,
  discoverChecksFor,
  enabledWorkflowKinds,
  enforcesAxisCoverage,
  fanoutOverriddenByLenses,
  ignoredUserConfigPaths,
  modelFor,
  parseGateOptions,
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
  worktreesDirFor,
} from "@agentic-workflow/core/config"
import { boundedShell } from "../bounded-shell.ts"
import type { Config } from "../config.ts"
import { splitVerb } from "../verb.ts"
import { armCron, armIdle, armPoll, claimsOnIdle, cronError, type TriggerMode, type WatchTimerHandle } from "./trigger.js"
import type { Action, WorkflowState, ShipPublish, Stage, TaskRef } from "@agentic-workflow/core/workflow/state"
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
  /**
   * `askOnPark` marks a PLAN drive a HUMAN asked for (`plan <id>`, the
   * `workflow_plan` tool, the `replan` chain) — the only ones whose park ends with
   * a question rather than a toast. It rides the work item rather than a module
   * map on purpose: a map would have to be cleared on every path a drive can die
   * on (ESC, stop, error, a dropped pending), and the one that got forgotten would
   * fire a dialog in a `watch` worker session with nobody at the terminal.
   */
  | { readonly kind: "start-plan"; readonly task: Task; readonly goal: string; readonly askOnPark?: true }
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
/**
 * Why a drive must halt, per driving session. Trips the chain's halt guard
 * without prematurely nulling `getWorkflow` (which `onIdle`'s catch still needs
 * on a reject-on-abort). Cleared when the drive unwinds.
 *
 * The two reasons are NOT interchangeable, which is why this is a reason map and
 * not a flag: `"interrupted"` (ESC) is a PAUSE — the snapshot is kept so
 * `recover <id>` resumes at that exact stage — while `"stopped"` (the verb) is an
 * END, and drops it. `stop` used to carry no flag at all and halt purely by
 * `clearWorkflow`, which the chain undoes at every transition (`setWorkflow`),
 * so a stop landing in the checkpoint/notes/advance window said "Loop stopped."
 * and then fired the next stage anyway.
 */
type HaltReason = "stopped" | "interrupted"
const haltReason = new Map<string, HaltReason>()
/**
 * Arm the halt, returning whether anything was armed.
 *
 * A deliberate `stop` WINS and is never downgraded: the stop verb aborts the
 * in-flight pass sessions, each abort surfaces as the `MessageAbortedError` a
 * human ESC does, and `onInterrupt` hops `passOf` back to this very session — so
 * without this precedence a stop with a fan-out in flight would re-label itself
 * an interrupt and KEEP the snapshot it exists to drop.
 */
const armHalt = (sessionID: string, reason: HaltReason): void => {
  if (reason === "interrupted" && haltReason.has(sessionID)) return
  haltReason.set(sessionID, reason)
}
/**
 * The reason this drive must halt, or undefined to continue. An externally
 * cleared workflow with no armed reason counts as a stop — what that case has
 * always rendered as.
 */
const haltedReason = (sessionID: string): HaltReason | undefined => haltReason.get(sessionID) ?? (getWorkflow(sessionID) ? undefined : "stopped")
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
 * Should this session stop firing agent turns? Either the loop was cleared, or a
 * halt is armed (`stop` verb or ESC). Both must be tested: `onInterrupt`
 * deliberately keeps `getWorkflow` set, so a `getWorkflow`-only check silently
 * keeps working after an interrupt (firing the remaining review lenses and the
 * verdict retry) — and the `stop` verb arms its reason BEFORE it clears the
 * workflow, so its own pass aborts are swallowed here rather than thrown as a
 * loop error.
 */
const halted = (sessionID: string): boolean => !getWorkflow(sessionID) || haltReason.has(sessionID)
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
 * Sessions in which a question has EVER been seen, and the windows open in each
 * right now. Two sources feed them, and the PRIMARY one is the model's own
 * `question` TOOL CALL, seen in `tool.execute.before`/`.after`
 * (`noteQuestionToolCall`/`noteQuestionToolSettled`): that is a seam this plugin
 * owns, where the `question.*` bus events are named by the host and can be
 * renamed by it. `noteQuestionEvent` stays as an additive second source, because
 * it is the only view of a window this plugin did not see opened as a tool call.
 * Neither can originate a question — both only watch one.
 *
 * `questionsObservable` is the bootstrap for every rule below: enforcement only
 * applies to a session we have PROOF we can observe. Against a host that shows
 * us neither signal, every guard here goes inert rather than wedging the loop — a
 * false allow only restores the old behaviour, a false refusal strands a task no
 * verb can free. The interactive `new`/`retask` flow always asks at least once
 * before it reaches a gate, so the path this exists for is always covered.
 *
 * Open windows are keyed by TOKEN, not by a bare per-session flag. Two reasons,
 * and both are bugs the flag had: the two sources must converge on ONE record
 * rather than double-count (the asked event carries `tool.callID`, the same id
 * the tool hooks carry, so they agree by construction), and one assistant message
 * may open two windows — under a flag the first settlement would clear while the
 * second was still up, handing the session to a drive underneath it.
 */
const questionsObservable = new Set<string>()
const questionOpen = new Map<string, Set<string>>()
/**
 * `requestID` → the `callID` its window was opened under, so a settle event that
 * names only the request still cancels the token the tool call filed. Dropped on
 * settle; a request we never saw opened resolves to its own `req:` token.
 */
const questionRequestCall = new Map<string, string>()

/**
 * Record a window opening. Idempotent per token, which is what lets both sources
 * report the same window without it counting twice.
 *
 * Opening also SATISFIES any ask a gate armed here: `askUnanswered` is a backstop
 * against skipping the question, not a proof that the right one was asked (see
 * `armTaskGateAsk`). `asked` deliberately survives the answer — whether the ask
 * was PUT is the thing being tested, and that outlives the window.
 */
const openQuestion = (sessionID: string, token: string): void => {
  questionsObservable.add(sessionID)
  const open = questionOpen.get(sessionID)
  if (open) open.add(token)
  else questionOpen.set(sessionID, new Set([token]))
  // Marks EVERY ask armed on this session, not just the newest. A window carries
  // no task id, so which armed ask a question answers is genuinely unknowable
  // here — and pretending otherwise would be worse than this imprecision, which
  // is the one the single-slot map already had.
  for (const armed of askArmed.get(sessionID)?.values() ?? []) armed.asked = true
}

/**
 * Record a window settling. A `null` token clears the session's whole set: a
 * settlement we cannot attribute to one window must never leave a token behind,
 * because nothing else in this process will ever remove it and `onIdle` refuses
 * the session for as long as one is there.
 */
const settleQuestion = (sessionID: string, token: string | null): void => {
  const open = questionOpen.get(sessionID)
  if (!open) return
  if (token === null) open.clear()
  else open.delete(token)
  if (open.size === 0) questionOpen.delete(sessionID)
}
/**
 * The one-shot "plan it now?" asks a TASK gate armed on a session — keyed by
 * session, then by TASK ID — with whether each has since been put to the human
 * and the remaining slices its follow-up named.
 *
 * The ask itself is prose (`gateNextStep`) because only the model can open a
 * question window — but prose is exactly what the orchestrator does not reliably
 * follow, and skipping it here is not a cosmetic loss: `workflow_plan` claims the
 * task and hands the user's own session to a PLAN drive, after which
 * `refuseIfDriven` and the absence of a free model turn mean nothing can ask the
 * human anything until the chain unwinds. So the prose gets a mechanism behind
 * it: `planFromAgent` refuses until a question was actually opened.
 *
 * Keyed per id rather than one slot per session because a slice-set walk gates
 * several children in ONE session by design. A single slot made arming B
 * *disarm* A, so planning A afterwards passed unchecked — the exact failure this
 * exists to prevent, on a task the human may have just said "not yet" to. The
 * entries are cheap and cannot wedge anything: unlike a `questionOpen` token,
 * nothing here holds `onIdle` off, so a leftover costs at most one question the
 * model must put before retrying.
 */
const askArmed = new Map<string, Map<string, { readonly siblings: readonly GateCandidate[]; asked: boolean }>>()

/**
 * A window the model opened with the `question` tool, and the same window
 * closing. THE primary signal: `tool.execute.before`/`.after` are this plugin's
 * own seam, so unlike the bus event names they cannot be renamed out from under
 * it — and the deny in `impl.ts` already keys off the same tool, so a stage's
 * refused ask is never recorded (it is denied before this is reached).
 *
 * Recorded under the CALLING session, never its driving ancestor: a child's
 * question must not satisfy an ask armed on the parent, and the session a window
 * must hold back from `onIdle` is the one the window is up in.
 */
export const noteQuestionToolCall = (sessionID: string, callID: string): void => openQuestion(sessionID, callToken(callID))
export const noteQuestionToolSettled = (sessionID: string, callID: string): void => settleQuestion(sessionID, callToken(callID))

/**
 * Any OTHER tool starting in this session, which closes its question windows.
 *
 * The safety valve on the whole scheme, and it exists because of what the failure
 * it covers costs. A window is opened here on `tool.execute.before` and closed on
 * `.after`; if that second hook ever does not fire — a host that skips it when
 * `execute` throws, a version that drops it — the token is permanent, `onIdle`
 * returns on it forever, and the session's queued drive plus the claim it already
 * placed are stranded. That is precisely the bug this whole mechanism was written
 * to fix, re-created by its own fix.
 *
 * Sound because a question BLOCKS the turn: the model cannot reach its next tool
 * until the human has answered, so a different tool starting is proof the window
 * is down. The known imprecision is a model that batches `question` with another
 * call in one message, where this clears early — and that is the right way to be
 * wrong here, the same asymmetry `askUnanswered` documents: clearing early only
 * restores the pre-guard behaviour for one idle tick, while a token nobody
 * removes wedges the backlog behind a task no verb can free.
 */
export const noteOtherToolCall = (sessionID: string): void => settleQuestion(sessionID, null)

/**
 * Drop every window a session has open, without touching what it PROVED. Called
 * where a window dies with no settlement anyone will report — an ESC, a `stop` —
 * since `onIdle` refuses the session for as long as a token is there and nothing
 * else would ever remove it.
 *
 * Deliberately leaves `questionsObservable` and `askArmed.asked` alone: clearing
 * the first would silently disarm the refusal, and the second is the record that
 * the ask was PUT, which has to survive the window either way.
 */
export const clearQuestionState = (sessionID: string): void => {
  questionOpen.delete(sessionID)
}

const callToken = (callID: string): string => `call:${callID}`
/** The token an event-reported window is filed under. The tool's callID when the
 *  host says which call opened it (so the two sources agree), else the request
 *  id, else one shared token — an unkeyed pair still opens and closes cleanly. */
const eventToken = (properties: Record<string, unknown> | undefined): string => {
  const callID = (properties?.tool as Record<string, unknown> | undefined)?.callID
  if (typeof callID === "string" && callID) return callToken(callID)
  const id = properties?.id
  return typeof id === "string" && id ? `req:${id}` : "req:*"
}

/**
 * Record a question event, and report whether it WAS one — the caller uses that
 * to stop, since a question event is never also an idle event.
 *
 * The SECOND source, additive to the tool-call signal above: it is the only view
 * of a window this plugin did not see opened as a tool call, and both sources
 * converge on one token. The `question.v2.*` family is normalised to the legacy
 * names first — the SDK's event union carries both, and which one a given host
 * build delivers is not something this plugin should have to be right about.
 *
 * `question.asked` both proves questions are observable here and satisfies any
 * ask a gate armed on this session; the two settlement events only close the
 * window, because whether the ask was PUT has to survive the answer — that is the
 * whole thing `askUnanswered` tests. Typed as `any` for the same reason
 * `abortedSessionID` is: the plugin's event union is host-versioned, and an
 * unknown shape must read as "not a question event", not fail the hook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noteQuestionEvent = (event: any): boolean => {
  const raw: unknown = event?.type
  if (typeof raw !== "string" || !raw.startsWith("question.")) return false
  const type = raw.replace(/^question\.v2\./, "question.")
  if (type !== "question.asked" && type !== "question.replied" && type !== "question.rejected") return false
  const properties = event?.properties as Record<string, unknown> | undefined
  const sessionID: unknown = properties?.sessionID
  if (typeof sessionID !== "string" || !sessionID) return true
  if (type === "question.asked") {
    const token = eventToken(properties)
    // Link request → call so a settlement naming only the request still cancels
    // the token the tool call filed, rather than leaving it open forever.
    if (typeof properties?.id === "string" && properties.id && token.startsWith("call:")) questionRequestCall.set(properties.id, token)
    openQuestion(sessionID, token)
  } else {
    const requestID = properties?.requestID
    if (typeof requestID === "string" && requestID) {
      const linked = questionRequestCall.get(requestID)
      questionRequestCall.delete(requestID)
      settleQuestion(sessionID, linked ?? `req:${requestID}`)
    } else {
      // Unattributable: clear the session rather than leave a token no one will.
      settleQuestion(sessionID, null)
    }
  }
  return true
}

/** Is a question waiting on the human in this session? Read-only seam — the
 *  wiring from `impl.ts`'s hooks is what it exists to make testable. */
export const isQuestionOpen = (sessionID: string): boolean => (questionOpen.get(sessionID)?.size ?? 0) > 0

/** Test seam: drop every per-session question/ask record. */
export const resetAskState = (): void => {
  questionsObservable.clear()
  questionOpen.clear()
  questionRequestCall.clear()
  askArmed.clear()
}
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
    return reject(stageDriftRefusal(state.stage, stage, { orchestrated: false }))
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
  // `seeded` carries the driver-run check commands SEPARATELY: they defeat the
  // "did nothing" rejection (this process ran them, trusting them is correct)
  // but cannot corroborate a PASS on their own (`seededOnlyMessage`).
  const evidence: EvidenceContext = {
    stage,
    required: def.requireEvidence,
    observed: observedEvidence.get(sessionID) ?? NO_OBSERVATIONS,
    seeded: checkCommands(state.checks?.[stage] ?? []),
  }
  // Stage-level via the predicate, never the per-pass `axisRequirement` map: a
  // lens pass clears that map, and the criteria gate must not suddenly bind
  // lens passes of an axis-bearing stage. Empty acceptance (sitter kinds carry
  // no task) leaves the gate inert.
  const criteria: CriteriaContext | undefined = stageRequiresCriteria(def)
    ? { stage, acceptance: state.task?.acceptance ?? [] }
    : undefined
  const admission = admitVerdict(
    record,
    axisRequirement.get(sessionID),
    prev?.stage === stage ? prev.record : null,
    evidence,
    criteria,
  )
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
  // Fired, never awaited. `toast`'s `.catch()` guards a rejection, not a HANG,
  // and this runs on the command-hook path where an await that never settles
  // kills the turn silently — for a notification whose result nothing reads.
  void toast(client, message, variant)
  return message
}

/** Git isolation lives in core (`@agentic-workflow/core/workflow/isolate`); these
 *  wrappers thread this plugin's `Deps` into its host-agnostic signatures. */
const ensureIsolation = (deps: Deps, config: Config, state: WorkflowState): Promise<WorkflowState> =>
  coreEnsureIsolation(deps.$, deps.log, deps.directory, config, state)

const teardownIsolation = (deps: Deps, config: Config, state: WorkflowState): Promise<void> =>
  // Gate on `isolated`, not `git`: a PR source pre-sets `git` to name the branch to
  // isolate onto, so a stage that never isolated (pr-sitter `triage` → done) must NOT
  // reach `coreTeardownIsolation`, which would checkout the base branch on the main tree.
  // Current-branch mode is the exception: a DEGRADED run (`isolated: false` after the
  // tree moved) still holds the one-run-per-tree lock from its last good boundary, and
  // core's teardown releases it owner-aware without touching the tree — skipping it
  // here is what used to wedge the tree until the stale sweep.
  state.isolated || state.git?.onCurrentBranch
    ? coreTeardownIsolation(deps.$, deps.log, deps.directory, config, state)
    : Promise.resolve()

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
): Promise<{ state: WorkflowState; source: ChecksSource; ran: number; refused: number; detail: string }> => {
  const dir = workTree(deps, state)
  const { defs, source, warnings } = await resolveStageChecks({
    $: deps.$,
    config,
    kind: loaded.manifest.kind,
    def: stageDef(loaded.manifest, stage),
    // The plan the loop is running against — re-extracted from the task file at
    // claim time, so it is the same text on every iteration of this task.
    plan: state.artifacts.plan,
    dir,
  })
  // Warn, never fail: a dropped or refused discovered check must leave the loop
  // exactly as it was before discovery existed, or a bad plan block becomes a
  // stalled run. The provenance (`source`, refusal count) is returned so the
  // drive records it durably — sample fields and, when the outcome would
  // otherwise be silent, an audit note; the log line alone was invisible.
  for (const w of warnings) await deps.log("warn", `${stage}: ${w}`)
  const detail = clampedChecksDetail(warnings)
  const provenance = { source, ran: defs.length, refused: warnings.length, detail }
  // A zero-defs iteration must clear any PRIOR iteration's results for this
  // stage, not merely skip writing new ones — `state` here is the carried-over
  // WorkflowState, and leaving `state.checks[stage]` untouched lets a stale
  // FAIL from an earlier run float forward and floor an honest PASS this
  // iteration never earned. `withCheckResults(state, stage, [])` is identity
  // for `finalizeCheckRecord` (empty results never floor) and for the composed
  // prompt (`ran?.length` is falsy either way) — so a task that never had
  // checks stays byte-identical, only a re-fire's staleness is cleared.
  if (!defs.length) return { state: withCheckResults(state, stage, []), ...provenance }
  // The phase below runs BEFORE this stage's marker write and claim restamp
  // (both sit between this call and the fire), on a claim stamp as old as the
  // previous stage's whole runtime — and sequential checks legally compound
  // past the stale window (`staleClaimMinutes` covers one stage, not caps × 8).
  // Mid-phase, both liveness oracles then read this LIVE run as dead: the stale
  // claim is swept by any rival walk, and the previous stage's expired marker
  // deadline is "crash evidence" to recover. So advertise a deadline covering
  // the whole check budget, restamp now, and restamp again before every check —
  // the gap another process can observe never exceeds one check's own cap.
  await writeOpencodeStageMarker(
    deps.$,
    deps.directory,
    config.tasksDir,
    opencodeStageMarker(state, Date.now() + checksBudgetMs(defs, config.checkTimeoutMinutes * 60_000)),
  )
  await refreshWorkClaim(deps.$, state)
  const results = await runChecks(deps.$, defs, dir, config.checkTimeoutMinutes * 60_000, () => refreshWorkClaim(deps.$, state))
  for (const r of results) {
    if (r.outcome === "pass") continue
    await deps.log("warn", `${stage} check "${r.name}" exited ${r.exitCode} (${r.command})`)
  }
  return { state: withCheckResults(state, stage, results), ...provenance }
}

/**
 * Check-command provenance per driving session × stage, for the stage's
 * samples and the once-per-run degradation note. Keyed like `runSamples`
 * (driving session), plus the stage; cleaned up wherever `runSamples` is.
 */
const stageChecksInfo = new Map<string, { source: ChecksSource; ran: number; refused: number; detail: string; noted: boolean }>()

const dropChecksInfo = (sessionID: string): void => {
  for (const key of stageChecksInfo.keys()) if (key.startsWith(`${sessionID}:`)) stageChecksInfo.delete(key)
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
  // Current-branch mode shares the tree. After this run's lock went stale and a
  // rival re-took it, `git add -A` here would commit the RIVAL's in-flight work
  // as this run's checkpoint — the stop/error paths reach here with no stage
  // boundary's re-hold in front of them. Free in the default modes: the
  // predicate short-circuits unless the state is on the current branch.
  if (await rivalHoldsCurrentBranchLock(deps.$, deps.directory, config, state)) {
    await deps.log("warn", "loop: this tree's current-branch lock is held by another run now — skipping this checkpoint")
    return
  }
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
  // Set when `rejectedFallback` salvaged a FAIL out of a twice-rejected verdict.
  // The coverage-gap conversion below has to know: converting a salvaged FAIL to
  // ERROR would undo the salvage the spent retry just bought, and the Claude
  // host carves out exactly this case (`salvagedFail` in its `workflow_advance`).
  let salvagedFail = false
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
      // The driver-run checks are NOT seeded into the observed set: they reach
      // admission as `EvidenceContext.seeded` (built in `recordVerdict` from the
      // state), where they defeat the "did nothing" rejection without being able
      // to corroborate a PASS on their own. Derivation, not mutation — so the
      // per-attempt clear above needs no re-seed.
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
        if (passRecord && effectiveVerdict(passRecord) === "FAIL") salvagedFail = true
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
        // Check-command provenance (`resolveStageChecks` computed it all along;
        // it was dropped) — what a check-discovery success roll-up joins on.
        ...(() => {
          const info = isCheck ? stageChecksInfo.get(`${sessionID}:${stage}`) : undefined
          return info ? { checksSource: info.source, ...(info.refused ? { checksRefused: info.refused } : {}) } : {}
        })(),
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
  // A salvaged FAIL stays FAIL. `withCoverageGap` worsens to ERROR, which for a
  // record that only exists BECAUSE its rejection was salvaged would throw away
  // what the spent retry bought and stop the run for a human, where the same run
  // on the Claude host re-builds with the findings. Same carve-out, same reason.
  const gapChecked =
    combined && gapped.length
      ? salvagedFail
        ? { ...combined, reason: [combined.reason, `(coverage gap: no verdict recorded for ${gapped.join(", ")})`].filter(Boolean).join(" ") }
        : withCoverageGap(combined, gapped)
      : combined
  // Floor the admitted record with the checks the driver ran, then refuse a
  // declared PASS whose every axis was unassessed. Applied HERE, at
  // finalization, and never inside `admitVerdict`: a pre-seeded check axis would
  // flow through `blockingFindingsIssue` and get a genuine agent PASS rejected
  // rather than derived down. Identity when every check passed and something
  // was assessed, so a green run records exactly what the agent recorded.
  const record = finalizeCheckRecord(gapChecked, state.checks?.[stage] ?? [])
  if (gapped.length) {
    await deps.log(
      "warn",
      `${stage} fan-out finished with no result for ${gapped.join(", ")} — ${salvagedFail ? "recording the salvaged FAIL with the gap noted" : "stopping with ERROR"}`,
    )
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
  dropChecksInfo(sessionID) // per-run like the samples it annotates
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
  /**
   * The chain's halt path — the `stop` verb, an ESC, or an externally cleared
   * workflow — preserving whatever the stage did as a checkpoint on the branch.
   * Returns null when the drive may continue.
   *
   * Called at BOTH halt boundaries, and the pre-fire one is not redundant: the
   * chain re-registers the session with `setWorkflow` at every transition, and
   * the window between the post-stage check and that call spans a checkpoint
   * commit and two audit notes. A stop landing there used to be undone —
   * "Loop stopped." to the user, and the next stage fired anyway. The same call
   * covers the pre-`setWorkflow` window at the top of a drive, where
   * `ensureIsolation` (worktree add, `npm ci`) can run for minutes.
   */
  const haltIfAsked = async (state: WorkflowState, stage: string): Promise<TerminalOutcome | null> => {
    const how = haltedReason(sessionID)
    if (!how) return null
    // Mirrors the `retryable: true` on this path's TerminalOutcome below.
    await renderMetrics(deps, sessionID, config, state, "stopped", `${how} during ${stage}`, true)
    await checkpoint(deps, config, state, `loop(${workflowId(state)}): incomplete — ${how} during ${stage}`)
    await teardownIsolation(deps, config, state)
    // The drive is over — release the claim marker (any stage). This guard
    // bypasses `runTerminal`, so without it an ESC/stop during PLAN left the
    // queued/ claim held: `plan <id>` then lied "just claimed by another
    // watcher" and only the 75-minute stale sweep freed it. A held marker
    // means "a loop is driving"; an interrupted (paused) run isn't — recover
    // re-claims when it resumes, and the CLAIMED note keeps watchers away.
    if (state.task) await releaseClaim(deps.$, state.task)
    // A deliberate stop ends the run — drop the snapshot so recover can't
    // resurrect stale state. An ESC interrupt is a pause: KEEP the snapshot so
    // recover <id> resumes at THIS stage (recover-state), not a BUILD
    // restart. A reject-on-abort already keeps it (onIdle's catch never clears state),
    // so both interrupt paths converge on exact-stage resume.
    if (state.task && how !== "interrupted") await clearState(deps.$, deps.directory, config.tasksDir, state.task.id)
    clearWorkflow(sessionID) // self-contained — no-op no-harm when stop already cleared it
    // A mid-drive interrupt / human ESC (or an externally-cleared loop) is not a
    // genuine exhaustion — mark it retryable so the work source keeps the item
    // claimable for the next poll rather than suppressing it forever (C2).
    return { kind: "stop", message: `${how} during ${stage}`, retryable: true }
  }
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
    if (stageDef(loaded.manifest, step.action.stage).kind === "check") {
      // Record the provenance for this stage's samples, and — ONCE per run,
      // only when the outcome would otherwise be silent — say so durably on the
      // task file. `checksProvenanceNote` owns the predicate and the phrasing
      // for both hosts: a fence whose commands are not what ran, and a
      // discovering stage that ran with no fence and zero commands (the run-time
      // truth beside the park-time forecast — a plan approved before the
      // forecast shipped reaches this fire with nothing on disk).
      const infoKey = `${sessionID}:${step.action.stage}`
      const prior = stageChecksInfo.get(infoKey)
      const info = { source: checked.source, ran: checked.ran, refused: checked.refused, detail: checked.detail, noted: prior?.noted ?? false }
      stageChecksInfo.set(infoKey, info)
      const note = checksProvenanceNote({
        stage: step.action.stage,
        source: checked.source,
        ran: checked.ran,
        refused: checked.refused,
        detail: checked.detail,
        fencePresent: hasChecksFence(step.state.artifacts.plan ?? ""),
        discovering: discoverChecksFor(config, loaded.manifest.kind, stageDef(loaded.manifest, step.action.stage)),
      })
      if (!info.noted && step.state.task && note) {
        info.noted = true
        const cur = await findByIdIn(deps.$, deps.directory, config.tasksDir, "in-progress", step.state.task.id)
        if (cur) {
          await appendNote(deps.$, cur, auditNote(note, new Date(), actor), deps.log)
        }
      }
    }
    if (checked.state !== step.state) {
      step = firstStep(loaded, checked.state, config)
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
    // Pre-fire boundary: a halt armed while the previous iteration was doing its
    // bookkeeping, or while this one was isolating, must not burn a whole stage.
    // Ahead of the BUILD-started note, so the audit trail never claims a stage
    // that never ran.
    const preFire = await haltIfAsked(step.state, step.action.stage)
    if (preFire) return preFire
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
    // Post-stage boundary: the loop was cleared or a halt armed while the stage
    // ran. The interrupt path leaves `getWorkflow` set (so `onIdle`'s catch stays
    // intact on a reject-on-abort), so the closure clears it itself.
    const postStage = await haltIfAsked(step.state, stage)
    if (postStage) return postStage
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
    // And publish it to DISK at the same point, for the same reason. The
    // snapshot is `recover`'s only oracle (`loadState` resumes at `snap.stage`,
    // and an ESC deliberately KEEPS it), but the only write used to be the one
    // at the top of the next iteration — on the far side of `ensureIsolation`
    // and `runStageChecks`. Through that window the file still named the stage
    // the loop had already left, so a recover/ESC resume re-entered at it: a run
    // that had reached REVIEW came back at VERIFY, and the live REVIEW subagent's
    // verdict was then refused as drift, retried, and thrown away.
    // Only for a `fire` of an isolated stage, mirroring the top-of-loop
    // predicate: PLAN never snapshots (see persist.ts), and a terminal action's
    // snapshot is `runTerminal`/`haltIfAsked`'s to keep or drop. The write up
    // there stays — it is the only one that captures the POST-isolation
    // `git`/worktree fields; this one publishes the stage promptly.
    if (step.action.kind === "fire" && stageDef(loaded.manifest, step.action.stage).isolation !== "none") {
      await snapshot(deps, config, step.state)
    }
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
 * The synchronous half of "stop watching": drop the session from `watching`,
 * kill its poll timer, and forget its per-session watch state. Split from
 * `stopWatching` so a caller racing an idle event (`onInterrupt`) can run every
 * map mutation BEFORE its first await — the lease release is the only async
 * part, and it must not gate the mutations that beat the racing idle. Returns
 * whether the session was watching.
 */
const forgetWatching = (sessionID: string): boolean => {
  const was = watching.delete(sessionID)
  stopWatchTimer(sessionID)
  lastSkipReason.delete(sessionID)
  watchKindFilter.delete(sessionID)
  return was
}

/**
 * The shared "stop watching" cleanup: `forgetWatching` plus the clone's watch
 * lease release (only if it was actually watching — a double release would
 * corrupt the shared per-directory refcount). Returns whether the session was
 * watching.
 */
const stopWatching = async (deps: Deps, sessionID: string): Promise<boolean> => {
  const was = forgetWatching(sessionID)
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
  const interruptedSessionID = sessionID // kept: `sessionID` is reassigned to the driving/pass id below
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
  // A real interrupt: an ESC on an open question dismisses the window, and
  // whether the host reports that as a settlement is its business, not something
  // this can depend on. An open token nothing ever removes is not a stale flag —
  // `onIdle` returns on it, so the session's queued drive AND the on-disk claim
  // it already placed are stranded for the life of the process, with every gate
  // verb then refusing the task as "a loop is driving this NOW". Both ids: the
  // window is up in the session the human ESC'd, which is not the driving one
  // mid-drive. Synchronous, ahead of every await below, for the same reason
  // `pending.delete` is.
  clearQuestionState(interruptedSessionID)
  clearQuestionState(sessionID)
  // EVERY map mutation ahead of EVERY await below — this is what the docstring's
  // "mutations are synchronous before the first await" promises, and it used to
  // be broken: the pass-abort loop awaited first, so a trailing `session.idle`
  // dispatched in that window still saw `watching`/`pending` set and started a
  // brand-new claim on the work the user had just ESC'd out of.
  const hadWorkflow = state !== undefined
  const priorPending = pending.get(sessionID)
  pending.delete(sessionID) // synchronous — beat the racing idle; marker released below
  claimRequested.delete(sessionID) // a dropped one-shot claim must not fire on the trailing idle
  // Only flag when a loop is actually driving — otherwise the flag would linger
  // (no drive to consume it in onIdle's finally) and wrongly halt this session's
  // NEXT loop. A running stage always has getWorkflow set (drive's setWorkflow), so the
  // interruptable moment is covered.
  //
  // `armHalt`, so an already-armed `stop` is never downgraded to a pause: the
  // stop verb's own pass aborts land right here, and an interrupt reading over
  // them would keep the crash snapshot the stop exists to drop.
  if (hadWorkflow) armHalt(sessionID, "interrupted")
  const wasWatching = forgetWatching(sessionID) // synchronous half; lease released below
  // Stop the passes the user cannot see. They run in their own
  // sessions, so ESC on the driving session never reached them — without this
  // the remaining lens/axis turns keep burning after the user asked to stop.
  for (const id of passSessions.get(sessionID) ?? []) {
    await deps.client.session.abort({ path: { id } }).catch(() => {})
  }
  await releasePendingMarker(deps, priorPending) // dropped one-shot work must not leave a held claim
  if (wasWatching) await releaseWatchLease(deps)
  // The interrupt keeps the snapshot, so recover resumes at the interrupted stage —
  // point the user straight at it. Toasts are fire-and-forget (report()'s rule):
  // this handler is AWAITED by the event hook, so a TUI call that never settles
  // here would park the ESC path — the one event that must always get through.
  if (hadWorkflow) {
    const id = state?.task?.id
    const msg = id ? `Loop interrupted — run /agentic-workflow:engineering recover ${id} to resume.` : "Loop interrupted."
    void toast(deps.client, msg, "info")
  } else if (wasWatching) {
    void toast(deps.client, "Stopped watching — interrupted.", "info")
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
  // A question window is open in this session, and a drive would bury it: stages
  // run as `session.command` calls on the DRIVING session (concurrency 1), so
  // claiming here takes over the very session the human is being asked in, and
  // `setWorkflow` then makes every gate tool refuse until the chain unwinds.
  // Returning before `pending.delete` leaves the work queued for the idle that
  // follows the answer — the same shape as the `executingDirs` bail below.
  //
  // There is deliberately NO timeout on this: a window the human has not got to
  // yet is legitimately open for hours, and expiring it would re-create the very
  // bug the guard exists to stop. What bounds it instead is that every way a
  // window can die without a settlement — ESC, `stop` — clears the session's
  // tokens itself. The log is the tell when it is still somehow held: a session
  // that silently never drives is otherwise indistinguishable from an idle one.
  if (isQuestionOpen(sessionID)) {
    if (pending.has(sessionID) || claimRequested.has(sessionID) || watching.has(sessionID)) {
      void deps.log("info", `idle: not driving ${sessionID} — a question window is open; the work stays queued for the idle after the answer`)
    }
    return
  }
  const work = pending.get(sessionID)
  // Nothing to do unless there's real pending work, a one-shot claim request,
  // or this is an idle watch session with no loop of its own currently running.
  const oneShotClaim = claimRequested.has(sessionID)
  // A plain idle event claims for poll/idle watchers only — cron kinds claim
  // exclusively when the schedule fires (which arrives as a one-shot claim).
  const idleMayClaim = claimsOnIdle(watchTriggerMode.get(sessionID) ?? "poll")
  const shouldWatch = ((watching.has(sessionID) && idleMayClaim) || oneShotClaim) && !getWorkflow(sessionID)
  if (!work && !shouldWatch) return
  // Serialize drives per working tree whenever they SHARE one — shared-tree
  // mode (two loops would switch branches out from under each other) and
  // current-branch mode (`taskBranch: false`, where two loops would commit
  // inside each other's diff boundary). In worktree mode each drive owns its own
  // checkout, so concurrent drives are safe and the lock is skipped
  // (`ensureIsolation` throws rather than falling back to shared-tree switching,
  // so the main tree's HEAD is never touched).
  //
  // In-process only — this Set belongs to one plugin instance. Current-branch
  // mode additionally holds a cross-process marker in `ensureIsolation`, because
  // there a second host's drive corrupts a verdict rather than a checkout.
  const serialize = !worktreesDirFor(config, "engineering")
  if (serialize && executingDirs.has(deps.directory)) return
  if (work) pending.delete(sessionID)
  driving.add(sessionID)
  if (serialize) executingDirs.add(deps.directory)
  // The PLAN drive's outcome, kept so a park a human asked for can be followed by
  // the gate question below. Every other exit — ESC, stop, a thrown stage — yields
  // a non-park outcome (or none), which is exactly why no cleanup bookkeeping is
  // needed for the arming flag.
  let planOutcome: TerminalOutcome | null = null
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
      planOutcome = await drive(deps, sessionID, config, firstStep(eng, planEntryState(work.task), config))
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
    // The drive died — release its claim marker unconditionally, whatever the
    // body says. The old gate (`isClaimable`) was always false once the CLAIMED
    // note landed, so every release was a silent no-op and the marker wedged
    // (the exact bug backlog.ts's `release` fixed with `isReleasableClaim`).
    // A held marker means "a loop is driving"; an errored one isn't — recover
    // re-claims, and the CLAIMED note keeps watchers away after release.
    //
    // FIRST, ahead of the audit note it used to follow: the note is best-effort
    // bookkeeping over a shell, and a rejection there (a `/mnt/c` hiccup, a
    // vanished task file) skipped the release, the teardown and `clearWorkflow`
    // outright — leaving a task every gate verb then refused as "a loop is
    // driving this NOW" until the 75-minute stale sweep. Nothing below may be
    // able to strand it again, so the rest is boxed too.
    const errored =
      work?.kind === "start-task" || work?.kind === "recover" || work?.kind === "start-plan"
        ? work.task
        : work?.kind === "recover-state"
          ? work.state.task
          : undefined
    if (errored) await releaseClaim(deps.$, errored).catch((e: unknown) => deps.log("warn", `claim release failed after a loop error: ${(e as Error).message}`))
    try {
      if (state?.task) {
        await appendNote(
          deps.$,
          state.task,
          auditNote(`Loop error: ${message}`, new Date(), await gitActor(deps.$, deps.directory)),
          deps.log,
        )
      }
      // Preserve whatever the failed run left behind. Teardown leaves the tree on
      // the work branch — on this path especially, that is where the partial work
      // is and where `recover` resumes.
      if (state) {
        await renderMetrics(deps, sessionID, config, state, "error", message)
        if (state.task) await commitBacklog(deps, config, state, `loop(${state.task.id}): loop error — ${message}`)
        await checkpoint(deps, config, state, `loop(${workflowId(state)}): incomplete — loop error`)
        await teardownIsolation(deps, config, state)
      } else {
        runSamples.delete(sessionID)
        dropChecksInfo(sessionID)
      }
    } catch (cleanupErr) {
      await deps.log("warn", `loop-error cleanup failed after "${message}": ${(cleanupErr as Error).message}`)
    }
    clearWorkflow(sessionID)
    // Fire-and-forget like every other toast: this one sits ahead of the
    // `finally` that releases `driving`, so a TUI call that never settles would
    // otherwise strand the session — onIdle returns on `driving.has` forever.
    void toast(deps.client, `Loop error: ${message}`, "error")
  } finally {
    driving.delete(sessionID)
    haltReason.delete(sessionID) // consumed by this drive; a fresh drive re-arms via onInterrupt / the stop verb
    if (serialize) executingDirs.delete(deps.directory)
  }
  // The plan gate. A parked plan is the one loop outcome with an obvious next
  // question, and until now this host could not put it: `plan <id>` returns before
  // the drive even starts, so by the time the plan exists there is no model turn
  // left to ask in. So the plugin starts one — the only thing it can do, since it
  // can never originate a question itself, only a turn in which the model does.
  //
  // AFTER the finally, deliberately: the session must be free of this drive
  // (`clearWorkflow` ran at the terminal, `driving` released here) or the plugin's
  // own ask is refused by the guards that stop a stage agent moving human gates.
  // And NEVER awaited — the turn it starts contains a question that blocks for as
  // long as the human takes, while `onIdle` is called from the event hook.
  if (work?.kind === "start-plan" && work.askOnPark && planOutcome?.kind === "park") {
    void promptPlanGateAsk(deps, sessionID, work.task.id)
  }
}

/**
 * Start one fresh model turn on the session that just planned, asking it to put
 * the plan gate's question to the human.
 *
 * Best-effort by construction: a failure here costs the dialog, not the plan —
 * which is parked in plan-review/ with the same toast as before, and
 * `/agentic-workflow:engineering approve` still crosses the gate by hand. So it
 * logs and swallows rather than propagating into a drive that already succeeded.
 */
const promptPlanGateAsk = async (deps: Deps, sessionID: string, id: string): Promise<void> => {
  try {
    await deps.client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: planParkNextStep(id) }] },
    })
  } catch (err) {
    void deps.log("warn", `could not open the plan gate question for "${id}": ${(err as Error).message} — the plan is parked in plan-review/ regardless`)
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

/**
 * Per-command cap on the shell a gate verb runs (see `gateCtx`). Generous on
 * purpose: the slowest legitimate gate command is the ship's `git push` /
 * `gh pr create`, and cutting one of those short costs a caveated ship ("PR not
 * opened") that a human can finish by hand — where NOT capping cost a run that
 * never came back at all.
 */
const GATE_SHELL_TIMEOUT_MS = 60_000

// --- Shared human-gate transitions -----------------------------------------
/**
 * Build the shared gate context from this host's deps. `isDriving` answers from
 * the in-memory session map so replan refuses a task a live loop is building.
 */
/** Exported for the wiring test only — every caller here is in this module. */
export const gateCtx = (deps: Deps, config: Config): GateCtx => ({
  // Bounded, unlike `deps.$` everywhere else. A gate verb's shell work is task
  // files, claim markers and small git bookkeeping — nothing here has a reason
  // to take a minute, and one that never returned wedged a `workflow_gate` call
  // (and the model's turn behind it) with the task already moved. A timeout
  // resolves exit 124, which core reads as an ordinary failed command, so the
  // move still reports; only the bookkeeping is skipped, and the log names the
  // command. Deliberately NOT applied to `deps.$`: checkpoint commits, worktree
  // setup and `runChecks` legitimately run long.
  $: boundedShell(deps.$, GATE_SHELL_TIMEOUT_MS, deps.log),
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
export const handleApprove = async (deps: Deps, sessionID: string, args: string, config: Config): Promise<string> => {
  const { client } = deps
  // The id is the first BARE word, not the first word: `approve t-42 --local`
  // carries a publish override in the same argument string, and taking word 0
  // blindly would make `approve --local` name a task called "--local".
  const words = args.trim().split(/\s+/).filter(Boolean)
  const opts = parseGateOptions(words)
  // A misspelled flag refuses rather than shipping under the configured default.
  // Same rule as the Claude/Qwen CLI arm, and the same reason: a ship that
  // publishes more than the human asked for cannot be taken back.
  if (!opts.ok) return report(client, opts.message, "error")
  // From the parser's leftovers, never a second scan of `words`: only the
  // parser knows which bare-looking words it already consumed as flag values.
  const id = opts.rest[0] ?? ""
  try {
    const r = await approveAny(gateCtx(deps, config), id, "engineering", opts.publish, opts.base)
    // A task gate leaves an obvious next question, and this host DOES get a
    // model turn after a handled verb (impl.ts overrides the command prompt with
    // this outcome). So the outcome carries the ask: nothing else can open a
    // question window — the plugin can only observe one, never originate it.
    // A refusal gets one too, but only the ambiguous one: it moved nothing, so
    // asking which task was meant is a first move, not a retry of a done one.
    return report(client, r.ok ? `${r.message}${armTaskGateAsk(sessionID, r.data, deps.log)}` : `${r.message}${gatePickNextStep(r.data)}`, gateVariant(r))
  } catch (err) {
    return report(client, `Approve failed${id ? ` for "${id}"` : ""}: ${(err as Error).message}`, "error")
  }
}

/**
 * The task id a gate result crossed the TASK gate for, or null for every other
 * gate (and for a core dist too old to report `data.gate`).
 *
 * The ONE place the gate is derived. Never re-derive it from `message` — that is
 * prose, and it gets reworded; `data.gate`/`data.id` are the contract core
 * promises on every success arm, `alreadyDone` retries included.
 */
const taskGateId = (data: Record<string, unknown>): string | null =>
  data.gate === "task" && typeof data.id === "string" ? data.id : null

/**
 * The follow-up a task gate leaves behind — also reused verbatim by
 * `askUnanswered`, so a refusal restates the same call in the same words rather
 * than a paraphrase the model has to reconcile with the one it already read.
 *
 * `NEXT STEP` is the label impl.ts's command-prompt override exempts from its
 * "report the result and stop" rule — the rule is there to stop the model
 * re-doing the plugin's deterministic work, not to forbid the one thing only the
 * model can do.
 */
const gateNextStep = (id: string, siblings: readonly GateCandidate[] = []): string =>
  `\n\nNEXT STEP — ask the user with the \`question\` tool: "Plan \`${id}\` now?" (options: yes / not yet). ` +
  `On yes, call the \`workflow_plan\` tool with id "${id}" — do NOT type or suggest a command, and do NOT approve anything else. ` +
  (siblings.length
    ? // Only the "no" arm walks. On yes, `workflow_plan` hands this session to a
      // PLAN drive at concurrency 1, after which there is no free model turn to
      // ask anything in — so the remaining slices are reported, not offered.
      `On no: the task waits in queued/, and this slice set has ${sliceCount(siblings.length)} still un-approved ` +
      `(${siblings.map((c) => `"${c.id}"`).join(", ")}). Ask ONE more \`question\`: "Approve \`${siblings[0]!.id}\` now?" ` +
      `(${siblings[0]!.title}) — on approve, call the \`workflow_gate\` tool with id "${siblings[0]!.id}" and follow ` +
      `the NEXT STEP it returns; on "not yet", stop. On yes to planning, name the remaining slices and stop — planning owns the rest of this turn.`
    : `On no, stop: the task waits in queued/.`)

/** "1 slice" / "2 slices" — these strings land in a human-read transcript too. */
const sliceCount = (n: number): string => `${n} ${n === 1 ? "slice" : "slices"}`

/**
 * The candidates on a gate result's `data`, or [] when the list is unusable — a
 * non-array, or an entry missing a field the prose interpolates.
 *
 * One malformed entry discards the WHOLE list rather than being filtered out: a
 * partial list would silently hide the very task the human meant, while the plain
 * message it falls back to still says everything core knows. The Claude hooks'
 * `usableCandidates` is the same predicate — the two hosts must not disagree
 * about which payloads are renderable.
 */
const gateCandidates = (value: unknown): GateCandidate[] => {
  if (!Array.isArray(value) || !value.length) return []
  const shaped = (c: unknown): c is GateCandidate => {
    const o = c as Record<string, unknown> | null
    return !!o && typeof o === "object" && typeof o.id === "string" && !!o.id && typeof o.title === "string" && typeof o.from === "string" && !!o.from
  }
  return value.every(shaped) ? (value as GateCandidate[]) : []
}

/**
 * The pick-one follow-up an ambiguous id-less approve leaves behind, or "" when
 * there is nothing to choose between.
 *
 * Prose and ONLY prose, deliberately — unlike the task gate's ask there is no
 * point of no return behind this one. A model that ignores it just reports
 * "Multiple tasks awaiting … pass an id", which is exactly today's behaviour, so
 * a mechanism would buy nothing and add a second thing to keep armed.
 *
 * `NEXT STEP` is the label impl.ts's command-prompt override exempts from its
 * "report the result and stop" rule, which is what gets this past a refusal.
 */
/**
 * Ids the follow-up names inline before deferring to the message — the same cap
 * the Claude/Qwen hooks apply (`MAX_LISTED` in gate-ask.mjs): the hosts must
 * not disagree about how a candidate list renders, and this whole paragraph is
 * also toasted, where an unbounded enumeration is unreadable.
 */
const MAX_LISTED_CANDIDATES = 6

const gatePickNextStep = (data: Record<string, unknown> | undefined): string => {
  if (!data?.ambiguous) return ""
  const candidates = gateCandidates(data.candidates)
  if (candidates.length < 2) return ""
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES)
  const rest = candidates.slice(MAX_LISTED_CANDIDATES)
  // An `in-review` option is a SHIP: the option text must say so, because the
  // human is choosing from one flat list where every other pick is reversible.
  const options = listed.map((c) => `\`${c.id}\` — ${c.title} (${c.from}${c.from === "in-review" ? " — picking it SHIPS the task: completed/, push, PR" : ""}${c.epic ? `, slice of epic \`${c.epic}\`` : ""})`).join("; ")
  const overflow = rest.length
    ? ` …and name the remaining ${rest.length} in the question text so they can be picked by id: ${rest.map((c) => `\`${c.id}\``).join(", ")}.`
    : ""
  return (
    `\n\nNEXT STEP — NOTHING has moved, and this plugin never guesses which task the human meant. ` +
    `Ask the user with the \`question\` tool: "Which task should \`approve\` advance?" — one option per candidate, in this order: ` +
    `${options}; plus "none — leave them all".${overflow} On a pick, call the \`workflow_gate\` tool with that exact id — do NOT type or ` +
    `suggest a command, and approve nothing else. On "none", stop: everything stays where it is.`
  )
}

/**
 * The plan gate's question, sent as its own turn after a human-requested PLAN
 * drive parks (`promptPlanGateAsk`).
 *
 * Every option names the TOOL that executes it, because an ask whose answer the
 * model cannot act on is worse than no ask: this host has no MCP server and
 * guards writes under `docs/tasks/`, so "tell the user to type the verb" is the
 * ask made pointless. `workflow_gate` crosses the plan gate (it is folder-driven);
 * `workflow_replan` rejects it and chains the revised plan, which parks and asks
 * again.
 */
const planParkNextStep = (id: string): string =>
  `NEXT STEP — the PLAN stage just finished: the plan for \`${id}\` is parked in plan-review/ and the loop has ended. ` +
  `Read the task file's Implementation Plan, summarize it for the user in a few lines, then ask them with the \`question\` tool: ` +
  `"Approve the plan for \`${id}\`?" (options: approve / replan / not now). ` +
  `On approve, call the \`workflow_gate\` tool with id "${id}" — the task becomes build-ready. ` +
  `On replan, ask what is wrong and call the \`workflow_replan\` tool with id "${id}" and that reason. ` +
  `On not now, stop: the plan waits in plan-review/. ` +
  `Do NOT type or suggest a command, do NOT run the plan yourself, and touch no OTHER task.`

/**
 * Arm the one-shot ask a task gate leaves behind, and return the prose that asks
 * the model to put it. Arming and asking are one call so the two can never
 * disagree about which gates ask — the failure that would either strand a plan
 * behind a question nobody wants, or leave the refusal below unreachable.
 *
 * One armed ask PER TASK, so a slice-set walk that gates several children in one
 * session arms one each instead of overwriting. It was one slot per session
 * once, and the shape a slice set makes normal — gate A, gate B, then plan A —
 * slipped straight through with ZERO questions: arming B disarmed A, so A was
 * planned with no question ever put. What the re-key closes is exactly that
 * zero-question case. It remains a backstop against a SKIPPED question, not
 * proof that the right one was asked: `openQuestion` cannot tell which task a
 * window was about, so ONE opened window still marks every armed sibling asked
 * — gate A, gate B, one question, and both plan without a second ask — and a
 * window the human answered "not yet" satisfies the guard the same as a yes
 * (the plugin can observe a window, never read its reply).
 *
 * The `data.gate`-less arm is the loud one, and it has to be: `data.gate`/`data.id`
 * live in CORE, which resolves to `packages/core/dist` — gitignored and rebuilt
 * only by `pnpm install`, while the installed plugin points at the working tree. So
 * pulling a new plugin against an old core dist lands exactly here, with `r.ok`
 * true and no gate on it, and the silent result is BOTH halves of a real bug: no
 * `NEXT STEP` reaches the model, and nothing is armed for `askUnanswered` to
 * enforce, so `workflow_plan` claims the human's session without ever asking.
 */
export const armTaskGateAsk = (sessionID: string, data: Record<string, unknown> | undefined, log: Log): string => {
  // `data` is OPTIONAL at runtime even though the ok result's type says
  // otherwise — an old core dist is exactly a runtime that predates that
  // contract, and it is the case this whole arm exists for. Dereferencing it
  // blind threw out of `handleApprove`, which reported `Approve failed` for a
  // move that had already succeeded, on every retry, with the `pnpm install`
  // warning below never reached. Same guard, same reason, as
  // `classifyReplanChain`'s.
  const id = data ? taskGateId(data) : null
  if (!id) {
    // The plan and ship gates legitimately do not ask; only a MISSING gate is a
    // defect worth reporting.
    if (data?.gate === undefined) {
      void log(
        "warn",
        "gate succeeded but reported no `gate`/`id` — the @agentic-workflow/core dist predates the gate contract, so the " +
          "'plan it now?' ask was NOT armed and workflow_plan will not be held for it. Run `pnpm install` at the agentic-workflow " +
          "repo root and restart opencode.",
      )
    }
    return ""
  }
  const siblings = gateCandidates(data?.siblings)
  const armed = askArmed.get(sessionID) ?? new Map()
  armed.set(id, { siblings, asked: false })
  askArmed.set(sessionID, armed)
  return gateNextStep(id, siblings)
}

/**
 * Refuse a `workflow_plan` that skipped the question its own task gate asked for,
 * naming the exact call that unblocks it — or null when there is nothing to
 * enforce.
 *
 * Three ways to pass, all deliberate: no gate armed an ask here for THIS id (a
 * plain `workflow_plan` on some older queued task is none of this rule's
 * business), a sibling's ask is armed but this task's is not, or a question HAS
 * been opened since.
 * And one bootstrap: a session where no question has ever been seen is never
 * refused, so against a host that shows us neither the tool call nor the
 * `question.*` events this degrades to the old behaviour instead of wedging
 * planning outright. That exit is logged — it is the difference between "the
 * human said yes" and "we could not tell", and the two used to look identical.
 */
const askUnanswered = (sessionID: string, id: string, log: Log): string | null => {
  const armed = askArmed.get(sessionID)?.get(id)
  if (!armed || armed.asked) return null
  if (!questionsObservable.has(sessionID)) {
    void log(
      "warn",
      `allowing workflow_plan on "${id}" without the gate's question: no question has ever been observed in session ${sessionID}, ` +
        "so the guard cannot tell a skipped ask from an answered one. The human may not have been asked before their session was claimed.",
    )
    return null
  }
  return (
    `Not yet — you approved "${id}" but never asked the human whether to plan it. ` +
    `Planning claims the task and hands THIS session to the PLAN stage, after which nothing can ask them anything until it finishes, ` +
    // Rebuilt from the ARMED record, so the refusal restates the arming call
    // word for word — including its slice walk. A paraphrase here would leave the
    // model reconciling two texts that disagree about what to do next.
    `so the question has to come first.${gateNextStep(id, armed.siblings)}`
  )
}

/**
 * Refuse a model-callable gate tool that is being called from inside a running
 * loop, and say why.
 *
 * A tool registered in the plugin's `tool:` map is offered to EVERY session,
 * stage subagents included — so without this a BUILD or REVIEW agent could
 * approve the very task it is driving, the self-grading hole `workflow_verdict`'s
 * stage check exists to close. `findDrivingWorkflow` walks the parent chain, so a
 * stage that runs as a subtask is caught by its driving ancestor.
 *
 * Fails CLOSED: the walk throws on a session-API failure, and "can't tell who is
 * calling" must refuse a gate move, not wave it through. That asymmetry is the
 * opposite of the Claude spawn guard's, and deliberately so — a false refusal
 * here costs one command the human can type, a false allow ships unreviewed work.
 */
const refuseIfDriven = async (deps: Deps, sessionID: string): Promise<string | null> => {
  try {
    const live = await findDrivingWorkflow(deps.client, sessionID)
    if (!live) return null
    return "A loop is driving in this session — a stage agent may not move the human's gates. Report your stage's outcome instead."
  } catch {
    return "Could not establish which session is calling — refusing the gate move. Ask the human to run the verb."
  }
}

/**
 * `workflow_gate` — the model-callable half of `approve`, for the interactive
 * `new`/`retask` turn: the agent asks "approve this draft?" with the `question`
 * tool and, on yes, moves the task here. Without it the ask is theatre — this
 * host has no MCP tools and writes under `docs/tasks/` are guarded, so the model
 * could not act on the answer it just collected.
 */
export const gateFromAgent = async (deps: Deps, sessionID: string, id: string, config: Config, publish?: ShipPublish, base?: string): Promise<string> => {
  const refusal = await refuseIfDriven(deps, sessionID)
  if (refusal) return refusal
  const target = id.trim()
  // Same guard as workflow_plan/workflow_replan. Without it an empty id falls
  // through to core's FOLDER-DRIVEN approve, whose first tier is
  // plan-review/in-review — so a degenerate call from an authoring turn could
  // silently SHIP the one in-review task (push + PR + completed/). The id-less
  // form buys nothing here: the ambiguity follow-up always names an exact id,
  // and the human's typed `approve` is the sanctioned id-less path.
  if (!target) return "workflow_gate needs the task id."
  try {
    // Bracketing log lines, because the frame this call stalls in is otherwise
    // unknowable: a tool that never returns leaves no transcript, and the last
    // time it happened the answer had to be reconstructed from file mtimes.
    void deps.log("info", `workflow_gate: moving "${target}" through its gate`)
    const r = await approveAny(gateCtx(deps, config), target, "engineering", publish, base)
    void deps.log("info", `workflow_gate: "${target}" → ${r.ok ? "moved" : "refused"} (${r.message})`)
    void toast(deps.client, r.message, gateVariant(r))
    // The ambiguous refusal carries its own follow-up: an id-less call from the
    // model lands here too, and a dead end there is what leaves a slice set
    // unapprovable without a typed command.
    return r.ok ? `${r.message}${armTaskGateAsk(sessionID, r.data, deps.log)}` : `${r.message}${gatePickNextStep(r.data)}`
  } catch (err) {
    return `Approve failed${target ? ` for "${target}"` : ""}: ${(err as Error).message}`
  }
}

/**
 * `workflow_plan` — the model-callable half of `plan <id>`, so the "plan it now?"
 * answer can be acted on in the same turn it was given. Delegates to the verb's
 * own handler, which owns the busy/liveness/claim-race guards.
 *
 * Gated on the question actually having been asked (`askUnanswered`): this call
 * is the point of no return for the human's session, so "the model skipped the
 * ask" must not be indistinguishable from "the human said yes".
 */
export const planFromAgent = async (deps: Deps, sessionID: string, id: string, config: Config): Promise<string> => {
  const refusal = await refuseIfDriven(deps, sessionID)
  if (refusal) return refusal
  const target = id.trim()
  if (!target) return "workflow_plan needs the task id."
  const unasked = askUnanswered(sessionID, target, deps.log)
  if (unasked) return unasked
  // Spend the ask whatever startPlanById makes of it: a refusal there (busy
  // session, lost claim race) is reported to the model, and re-demanding the
  // question on the retry would just teach it to ask twice. Only THIS task's ask
  // is spent — a sibling's still has its own question owed.
  askArmed.get(sessionID)?.delete(target)
  // startPlanById reports through the toast and can return undefined; a tool must
  // answer the model in words, or it reads as an empty success.
  return (await startPlanById(deps, sessionID, target, config)) ?? `Planning "${target}" — it will park in plan-review/ for the human's gate.`
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
    // turn reports the reshape, and a toast per retask would double up. Fired,
    // never awaited: this runs on the command-hook path, where an unsettled
    // await kills the turn silently (report()'s rule).
    if (!r.data?.alreadyDone) void toast(client, r.message, gateVariant(r))
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
 *
 * `askOnPark` is set unconditionally here, and that is the whole boundary between
 * a park that asks and a park that only toasts: every caller of THIS function is a
 * human saying "plan it now" in a session they are sitting in, while the watcher's
 * claim walk (`tryClaim`) never comes through here. A `watch` worker is unattended
 * by definition — a question there stalls the loop on nobody.
 */
const claimForPlan = async (deps: Deps, sessionID: string, task: Task, config: Config): Promise<boolean> => {
  if (!(await claimTask(deps.$, task))) return false
  // Planning it now honours any plan request for it just as a claim walk
  // would, so the marker must not outlive this — otherwise the board keeps
  // showing "plan requested" for a task that is being planned right now.
  await consumePlanRequest(deps.$, deps.directory, config.tasksDir, task.id, "queued")
  clearWorkflow(sessionID)
  await setPending(deps, sessionID, { kind: "start-plan", task, goal: taskGoal(task), askOnPark: true })
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
    const outcome = await replanAndChain(deps, sessionID, args, config)
    return report(client, outcome.message, outcome.variant)
  } catch (err) {
    return report(client, `Replan failed: ${(err as Error).message}`, "error")
  }
}

/**
 * Why a chained re-plan did not fire. Every arm used to fall back SILENTLY to
 * core's plan-next message — "the chain ran" and "the chain could not run"
 * produced the same transcript, the exact defect class the question-window
 * rules document ("the human said yes" vs "we could not tell"). So each skip
 * carries its log level and whether the fallback answer should name the tool
 * that re-plans NOW: `nextStep` is true only on the arms where this session is
 * free, because on the busy/raced arms `workflow_plan` would just hit the same
 * guard and core's plan-next promise is the right answer.
 */
type ChainSkip = { readonly why: string; readonly level: "warn" | "info"; readonly nextStep: boolean }

const CHAIN_SKIPS = {
  staleDist: {
    why:
      "core reported no `requeued`/`id` gate data — the @agentic-workflow/core dist predates the gate contract. " +
      "Run `pnpm install` at the agentic-workflow repo root and restart opencode.",
    level: "warn",
    nextStep: true,
  },
  busy: {
    why: "this session is mid-loop or the task is already driven — the plan-next marker means the next claim/watch re-plans it first",
    level: "info",
    nextStep: false,
  },
  gone: { why: "the re-queued task was not found in queued/ after the move", level: "warn", nextStep: true },
  raced: { why: "a watcher claimed the task first — it re-plans the task there", level: "info", nextStep: false },
} as const satisfies Record<string, ChainSkip>

/**
 * Classify core's rejection outcome for the chain: the id to chain on, a skip
 * (the rejection LANDED but the chain cannot run), or null (the rejection
 * itself failed — core's refusal message is the whole answer, nothing to log).
 * Pure, and exported because the stale-dist arm is exactly the shape the real
 * core in this tree can never emit — only a unit test can reach it.
 */
export const classifyReplanChain = (r: GateResult): { readonly id: string } | ChainSkip | null => {
  if (!r.ok) return null
  // `?.` defensively: the type says `data` always rides an ok result, but the
  // stale dist this arm exists for is precisely a runtime that predates that —
  // a bare `.requeued` would turn a SUCCEEDED move into a thrown "Replan failed".
  const id = r.data?.requeued && typeof r.data.id === "string" ? r.data.id : null
  return id ? { id } : CHAIN_SKIPS.staleDist
}

/**
 * The host-correct next step for a fallback answer, `planParkNextStep` style:
 * it names `workflow_plan` — a tool that EXISTS on this host — because core's
 * `data.next` names the Claude host's `workflow_start` and is not surfaced
 * here anyway. Without this the model's best remaining idea is hand-editing
 * the plan under the backlog, which the edit guard rightly blocks.
 */
const replanNextStep = (id: string | null): string =>
  ` NEXT STEP — to re-plan now, call the \`workflow_plan\` tool with ${id ? `id "${id}"` : "the task's id"} ` +
  `(the human can also run ${ECMD} plan ${id ?? "<id>"}). Do NOT edit the plan by hand — writes under the backlog are guarded.`

/** Report a skipped chain: log the arm (the transcript tell) and answer with
 *  core's message, plus the executable next step on the arms that earn one. */
const chainSkipped = (
  deps: Deps,
  r: GateResult,
  id: string | null,
  skip: ChainSkip,
): { readonly message: string; readonly variant: "info" | "success" | "warning" | "error" } => {
  void deps.log(skip.level, `replan(${id ?? "?"}): chain skipped — ${skip.why}`)
  return { message: skip.nextStep ? `${r.message}${replanNextStep(id)}` : r.message, variant: gateVariant(r) }
}

/**
 * The rejection + chained re-plan itself, shared by the `replan` VERB and the
 * `workflow_replan` tool so the two can never drift about what a rejection does.
 * Presentation is the caller's (the verb replaces the rendered markdown; the tool
 * answers the model and toasts).
 */
const replanAndChain = async (
  deps: Deps,
  sessionID: string,
  args: string,
  config: Config,
): Promise<{ readonly message: string; readonly variant: "info" | "success" | "warning" | "error" }> => {
  const r = await rejectAny(gateCtx(deps, config), args.trim())
  const chain = classifyReplanChain(r)
  if (chain === null) return { message: r.message, variant: gateVariant(r) }
  if (!("id" in chain)) return chainSkipped(deps, r, null, chain)
  const { id } = chain
  // Chain the re-plan unless this session is mid-loop or the task is taken —
  // the same guards `plan <id>` runs, minus the resolution core already did.
  if (driving.has(sessionID) || getWorkflow(sessionID) || findSessionDriving(id)) {
    return chainSkipped(deps, r, id, CHAIN_SKIPS.busy)
  }
  const queued = await findByIdIn(deps.$, deps.directory, config.tasksDir, "queued", id)
  if (!queued) return chainSkipped(deps, r, id, CHAIN_SKIPS.gone)
  if (!(await claimForPlan(deps, sessionID, queued, config))) return chainSkipped(deps, r, id, CHAIN_SKIPS.raced)
  return {
    message: `Plan rejected for "${queued.title}" — re-planning now… (a revised plan will park in plan-review/ for your gate)`,
    variant: "info",
  }
}

/**
 * `workflow_replan` — the model-callable half of `replan`, so the plan gate's
 * "replan, because…" answer can be acted on in the turn it was given.
 *
 * Without it the plan-gate question (`planParkNextStep`) would offer an option
 * only the human could execute, by typing the verb — which is the ask made
 * pointless, the same reason `workflow_gate` exists for the draft question.
 *
 * `refuseIfDriven` first, failing closed: this tool is offered to every session,
 * stage subagents included, and a BUILD agent must never reject the plan it is
 * building against.
 */
export const replanFromAgent = async (deps: Deps, sessionID: string, id: string, reason: string, config: Config): Promise<string> => {
  const refusal = await refuseIfDriven(deps, sessionID)
  if (refusal) return refusal
  const target = id.trim()
  if (!target) return "workflow_replan needs the task id."
  try {
    // Core's `reject-any` parses "<id> <reason…>" as one argument string, the same
    // shape the verb passes — a rejection with no reason is legal and stays legal.
    const outcome = await replanAndChain(deps, sessionID, `${target} ${reason.trim()}`.trim(), config)
    void toast(deps.client, outcome.message, outcome.variant)
    return outcome.message
  } catch (err) {
    return `Replan failed for "${target}": ${(err as Error).message}`
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
  `Usage: ${ECMD} new <idea> · retask <id> [note] · approve [id] [--base=<branch>] [--pr|--push|--local] · replan [id] [reason] · ` +
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
    // EVERY mutation ahead of EVERY await, exactly as `onInterrupt` orders its
    // own. The stage may settle inside any of the awaits below, so the halt has
    // to be visible before the first one — and the pass aborts further down
    // dispatch abort errors that `runStagePasses` only swallows once `halted`
    // says so. Arming after them is what turned a stop into "Loop error", with
    // the crash snapshot left behind for `recover` to resurrect.
    //
    // `driving` as well as `getWorkflow`, matching claim/plan/recover's busy
    // test: the chain does not call `setWorkflow` until after `ensureIsolation`
    // (worktree add, `npm ci`), and a stop typed in that window used to report
    // "No active loop to stop." and halt nothing at all.
    const state = getWorkflow(sessionID)
    const existed = driving.has(sessionID) || state !== undefined
    if (existed) armHalt(sessionID, "stopped")
    // A window whose settlement never arrived would otherwise keep `onIdle`
    // returning here for the life of the process — and `stop` is the verb a user
    // reaches for precisely when a session has gone quiet on them, so it must be
    // able to clear it. Same reason as the ESC path in `onInterrupt`.
    clearQuestionState(sessionID)
    claimRequested.delete(sessionID) // a queued one-shot claim dies with the stop
    const wasWatching = await stopWatching(deps, sessionID)
    await dropPending(deps, sessionID) // release any queued-but-undriven claim marker
    // Stop the fanned-out passes the user cannot see, exactly as onInterrupt
    // does: they run in their own sessions, so clearing the workflow alone
    // leaves N lens/axis turns burning tokens against a loop the user just
    // killed, their late verdicts racing closePassSession's table cleanup.
    for (const id of passSessions.get(sessionID) ?? []) {
      await client.session.abort({ path: { id } }).catch(() => {})
    }
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
    // Still cleared, so every `getWorkflow` consumer sees no live loop — but the
    // armed reason above, not this, is what halts the chain: it re-registers the
    // session at every transition.
    clearWorkflow(sessionID)
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
    // Fired, never awaited: command-hook path — an unsettled await here kills
    // the turn silently (report()'s rule).
    void toast(client, message, "info")
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
      // Two independent forms of crash evidence, either of which authorizes an
      // immediate takeover:
      //
      //  - a DEAD stage marker naming the task — a run reached a stage and its
      //    writer died;
      //  - a claim stamp naming a pid on this machine that no longer exists —
      //    which is the only evidence available when the run died BEFORE its
      //    first stage marker (isolation, worktreeSetup/npm ci, check
      //    discovery), the case that used to cost a 15-minute wait behind
      //    advice ("stop it first") no other process can act on.
      //
      // Without either, the marker is ambiguous: a just-claimed live run spends
      // minutes in that same setup window, and an unconditional sweep there
      // started a second drive on the same feature/<id> branch. Only a claim
      // stamp older than the base stale window authorizes the takeover there.
      const namedByMarker = await taskNamedByStageMarker(deps.$, deps.directory, config.tasksDir, id)
      // Skipped when the marker already settled it — the probe costs subprocesses.
      const writer = namedByMarker ? "unknown" : await claimWriterState(deps.$, task)
      // Both crash arms take the IDENTITY-judged sweep, never `…Stale(t, 0)`: a
      // zero age window cannot re-judge what the rename caught (see
      // `releaseMarkerIfWriterDead`), so it deletes a rival's fresh claim
      // created inside the rename window — the double-drive the rename-aside
      // exists to stop. The stage-marker arm's evidence says the OLD run died;
      // it says nothing about who holds the claim NOW, which is what the
      // re-judge answers. When the identity judge cannot decide (an unstamped
      // pre-stamp marker, another machine), fall back to the wall-clock window
      // rather than an unconditional sweep — the safe direction is a wait, not
      // a second drive on one feature/<id> branch.
      const took = namedByMarker
        ? (await claimTaskSweepingDeadWriter(deps.$, task)) || (await claimTaskSweepingStale(deps.$, task, STALE_CLAIM_MINUTES))
        : writer === "dead"
          ? await claimTaskSweepingDeadWriter(deps.$, task)
          : await claimTaskSweepingStale(deps.$, task, STALE_CLAIM_MINUTES)
      if (!took) {
        return report(
          client,
          namedByMarker || writer === "dead"
            ? `Task "${id}"'s claim marker was just re-taken by another process — nothing to recover.`
            : writer === "alive"
              ? `Task "${id}"'s claim is held by a live process on this machine that has not written a stage marker yet — ` +
                  `it is probably still setting up (isolation, dependency install). Stop that run, or retry once its claim goes stale ` +
                  `(${STALE_CLAIM_MINUTES} minutes).`
              : `Task "${id}"'s claim is less than ${STALE_CLAIM_MINUTES} minutes old, no stage marker exists yet, and its holder ` +
                  `cannot be identified on this machine — the claiming run may still be setting up before its first stage. ` +
                  `If you know it is gone, run ${ECMD} doctor fix; otherwise retry once the claim goes stale.`,
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
        // Liveness must be judged ACROSS processes, not just in this one.
        // `findSessionDriving` only knows this app's own sessions, so a task
        // driven by the Claude host (or another OpenCode instance) reads as
        // "not driving" here — and paired with `isOrphanedStartedClaim`, which
        // ignores the CLAIMED/BUILD body on purpose, doctor would release a
        // LIVE drive's claim the moment its marker aged past the window (a
        // stalled orchestrator, a slow subagent). The stage marker is the
        // cross-process witness (deadline + writer pid), same oracle the hub's
        // doctor uses; a dead or expired one still releases, so the wedged
        // markers doctor exists for are unaffected.
        const liveDriven = new Set<string>()
        for (const id of ids) {
          if (await taskDrivenByStageMarker(deps.$, deps.directory, config.tasksDir, id)) liveDriven.add(id)
        }
        released.push(
          ...(await releaseOrphanedClaims(deps.$, tasks, ids, path.join(deps.directory, config.tasksDir, status), {
            isDriving: (id) => findSessionDriving(id) !== undefined || liveDriven.has(id),
            staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
            // The window above is a proxy for "the claimer died"; the stamp can
            // often prove it. Without this, doctor — the fallback the gate verbs
            // send users to — could not clear a wedged marker for 75 minutes
            // even when its process was demonstrably gone.
            writerDead: (ref) => claimWriterDead(deps.$, ref),
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
