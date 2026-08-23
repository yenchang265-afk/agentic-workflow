#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { stageOrderError } from "./stage-guard.js"
import { sharedAdoGateway } from "@agentic-workflow/ado-mcp/gateway"
import { STALE_CLAIM_MINUTES, staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { DEFAULT_CONFIG, bashAllowlistPrefixes, parseGateOptions, stageBashGlobs, loadConfig } from "@agentic-workflow/core/config"
import { SHIP_PUBLISH_MODES, type Action, type Config, type ShipPublish, type WorkflowState, type TaskRef } from "@agentic-workflow/core/workflow/state"
import { advance, composePrompt, composePromptWithStats, firstStep, withCheckResults } from "@agentic-workflow/core/workflow/engine"
import { checkCommands, checksBudgetMs, finalizeCheckRecord, runChecks } from "@agentic-workflow/core/workflow/checks"
import { registerEngineeringHooks } from "@agentic-workflow/core/kinds/engineering"
import type { AdoGateway } from "@agentic-workflow/core/source/ado-gateway"
import { defaultWorkflowsDir } from "@agentic-workflow/core/manifest/dir"
import { effectivePlatformTools, stageDef, stageRequiresCriteria, type LoadedManifest, type StageDef } from "@agentic-workflow/core/manifest/schema"
import { pollOnce } from "@agentic-workflow/core/scheduler/scheduler"
import { appendSchedulerEvents, skipSetKey, type SchedulerEvent } from "@agentic-workflow/core/scheduler/events-log"
import { aggregateDenials, appendDenyEntry, clearDenyLog, formatDenyFindings, readDenyLog } from "@agentic-workflow/core/workflow/deny-log"
import { initRepo } from "@agentic-workflow/core/workflow/init"
import {
  buildEntryState,
  buildWorkSources,
  workflowWorkTree,
  makeManifestCache,
  planEntryState,
} from "@agentic-workflow/core/workflow/orchestrate"
import type { PolledClaim } from "@agentic-workflow/core/scheduler/scheduler"
import type { WorkSource } from "@agentic-workflow/core/source/types"
import { checksProvenanceNote, clampedChecksDetail, hasChecksFence, resolveStageChecks, type ChecksSource } from "@agentic-workflow/core/workflow/discovered-checks"
import {
  concurrentStages,
  discoverChecksFor,
  enabledWorkflowKinds,
  enforcesAxisCoverage,
  modelFor,
  passAxes,
  platformFor,
  spawnAlias,
  stagePasses,
  unbindableAgentModels,
  unknownAgentModelKeys,
  effectiveConfigReport,
  unknownStageCheckKeys,
  unknownStageConcurrencyKeys,
  unknownStageContextKeys,
  unknownStageFanoutKeys,
  taskBranchPrefix,
  unknownStageModelKeys,
  unreviewedAxes,
  worktreesDirFor,
} from "@agentic-workflow/core/config"
import {
  admitVerdict,
  axisUnassessed,
  axisVerdict,
  effectiveVerdict,
  mergeRejected,
  noAdmissibleVerdictReason,
  parseVerdict,
  passFocusBlock,
  rejectedFallback,
  stageDriftAdvice,
  stageDriftNote,
  stageDriftRefusal,
  uncoveredAxes,
  withCoverageGap,
  type AxisResult,
  type CriteriaContext,
  type CriterionResult,
  type RejectedVerdict,
  type StagePass,
  type Verdict,
  type VerdictRecord,
} from "@agentic-workflow/core/workflow/verdict"
import type { EvidenceContext, EvidenceItem, ObservedEvidence } from "@agentic-workflow/core/workflow/evidence"
import { renderRunSummary, type Outcome, type StageSample, verdictStructure } from "@agentic-workflow/core/workflow/metrics"
import { metricsPath, upsertRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import { hostStageEvidencePath, hostStageMarkerPath, hostVerdictNagPath, taskDrivenByStageMarker, taskNamedByStageMarker } from "@agentic-workflow/core/workflow/stage-marker"
import { CHECKPOINT_LOCKFILE_EXCLUDES, commitAll, commitPaths, currentBranch, gitActor, listWorktrees, pruneWorktrees } from "@agentic-workflow/core/workflow/git"
import { ensureIsolation, releaseWorktree, rivalHoldsCurrentBranchLock, workflowId } from "@agentic-workflow/core/workflow/isolate"
import {
  approveAny as coreApproveAny,
  approvePlan as coreApprovePlan,
  approveTask as coreApproveTask,
  planCaveats,
  findAnyStatus as coreFindAnyStatus,
  rejectAny as coreRejectAny,
  abandonTask as coreAbandonTask,
  commitBacklog as coreCommitBacklog,
  removeTask as coreRemoveTask,
  replanTask as coreReplanTask,
  retaskTask as coreRetaskTask,
  shipAny as coreShipAny,
  type GateCtx,
  type GateResult,
} from "@agentic-workflow/core/workflow/gate"
import { runTerminal as coreRunTerminal, type TerminalCtx, type TerminalReport } from "@agentic-workflow/core/workflow/terminal"
import { loadState, saveState } from "@agentic-workflow/core/workflow/persist"
import { type Task } from "@agentic-workflow/core/task/schema"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimTask,
  claimTaskSweepingDeadWriter,
  claimTaskSweepingStale,
  claimWriterDead,
  claimWriterState,
  confirmedStrayPlanRequestIds,
  findByIdIn,
  isClaimable,
  isOrphanedPlanClaim,
  isOrphanedStartedClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  nextActions,
  markClaimed,
  moveTask,
  pairingCoverage,
  refreshWorkClaim,
  releaseClaim,
  releaseOrphanedClaims,
  rescueStray,
  resolveTaskIdAnywhere,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-workflow/core/task/store"
import { consumePlanRequest, requestPlan, revokeStrayPlanRequests } from "@agentic-workflow/core/task/plan-request"
import { auditBacklog, formatAnomalies, hasAnomalies } from "@agentic-workflow/core/task/audit"
import { isLeaseStale, readLeaseOwner, staleThresholdMs } from "@agentic-workflow/core/scheduler/lease"

/**
 * MCP server backing the agentic-workflow Claude Code plugin. It holds the loop's
 * WorkflowState (the same pure state machine the OpenCode driver uses) and exposes
 * the deterministic/trusted operations as tools the MAIN agent calls while it
 * drives BUILD→VERIFY→REVIEW via the Task tool. The autonomous background
 * driver is gone (no Claude Code equivalent) — the agent is the driver; this
 * server is the trusted state + git/backlog substrate.
 *
 * Task authoring happens before the loop, via `/agentic-workflow:engineering new`: it interviews
 * the user into a draft (main-agent turn) and `workflow_approve` (unified gate)
 * parks it planless in `queued/`. Planning happens inside the loop, right before
 * execution: `workflow_start` on a queued task enters at PLAN (no git isolation
 * — it writes only the task file), `workflow_claim` reaches the same pool once
 * no build-ready work is left, and `workflow_advance` after PLAN
 * parks the task in `plan-review/` and ends the loop (`park`). The human plan
 * gate is `workflow_plan_approve` (plan-review → in-progress); `workflow_replan`
 * sends a rejected or cap-tripped task back to `queued/`. From `in-progress/`
 * — the build-ready queue — claims enter at BUILD.
 *
 * There is no `/agentic-workflow:engineering watch` here, deliberately: watch needs an autonomous
 * driver firing stages on idle events/timers, and the MCP server can't spawn
 * subagents. `workflow_claim` is the pull equivalent — one human trigger claims
 * the next approved task.
 */

const directory = process.env.AGENTIC_WORKFLOW_DIR ?? process.cwd()
/**
 * Where to read the base branch for a fresh `feature/<id>` worktree. `directory`
 * (the canonical root: backlog + worktree parent) is frozen at server launch
 * on the main checkout — usually the default branch — so worktrees would
 * always cut from it. Point `AGENTIC_WORKFLOW_BASE_DIR` at the tree you actually
 * work in and the base is read there live (per claim). Unset ⇒ core falls back
 * to `directory`'s branch (today's behavior).
 */
const baseDir = process.env.AGENTIC_WORKFLOW_BASE_DIR
const resolveBase = async (): Promise<string | undefined> =>
  baseDir ? ((await currentBranch(sh, baseDir)) ?? undefined) : undefined
/** The workflow-kind manifests shipped with core (packages/core/workflows/<kind>/) —
 *  resolved from core's own install location so the server works from any cwd
 *  and survives plugin relocations. */
const WORKFLOWS_DIR = defaultWorkflowsDir()
const manifestFor = makeManifestCache(WORKFLOWS_DIR, ["engineering"])
const eng = manifestFor("engineering")
registerEngineeringHooks()
const log = (level: "info" | "warn" | "error", message: string) =>
  fsClient.app.log({ body: { service: "agentic-workflow", level, message } })

// --- shared in-process loop state (one active loop per server/session) ---

let active: WorkflowState | null = null
let activeClaim: PolledClaim | null = null // the scheduler claim behind `active`, when workflow_claim made it
let pending: VerdictRecord | null = null // verdict(s) recorded for the current check stage
let verdictRetried = false // whether the current check stage already got its one no-verdict re-fire
/**
 * The last verdict `admitVerdict` REFUSED for the current check stage, or null.
 *
 * The refused RECORD, not a boolean: it changes the re-fire wording, and once the
 * retry is spent `rejectedFallback` routes the stage on what it declared instead
 * of ERROR-stopping a review that plainly failed (see verdict.ts).
 */
let verdictRejected: RejectedVerdict | null = null
/**
 * The out-of-stage verdict this stage attempt already audited, or null.
 *
 * The RECORD, not a boolean: it still dedupes the task-file note (a drifting
 * agent may call repeatedly), but it is also what `workflow_advance` reports back
 * to the orchestrator. The note alone was invisible where it mattered — the
 * driving model never reads the task file, and on this host the driving model is
 * the thing that skipped the call.
 */
let drifted: { readonly requested: string; readonly verdict: Verdict } | null = null
/**
 * A "cannot do this work at all" signal from `workflow_blocked` for the current
 * WORK stage — the approved plan is impossible, not merely hard.
 *
 * Deliberately separate from `pending`: `workflow_verdict` rejects work stages on
 * purpose, so that a build agent can never pre-empt its own verification. This
 * lets a work stage refuse the work without being able to grade it.
 */
let blocked: { readonly stage: string; readonly reason: string } | null = null
/**
 * The focused pass currently armed on a check stage, if any — what
 * `workflow_verdict` admits against and what the next metrics sample is
 * attributed to. Null on a single-pass stage and between passes.
 */
let armedPass: { readonly stage: string; readonly pass: StagePass; readonly index: number; readonly total: number } | null = null
/**
 * The stage whose fan-out is still accumulating verdicts, or null.
 *
 * Separate from `armedPass` because it answers a different question:
 * `workflow_stage` normally wipes `pending` ("a fresh stage starts empty"), and
 * under fan-out that would throw away every earlier pass's axis the moment the
 * next one is armed — merging the passes is the entire point. It must also
 * survive the axis retry below, which clears `armedPass` (its sample is already
 * recorded) but must not lose the axes that did report. Cleared on every
 * transition.
 */
let fanoutStage: string | null = null

/**
 * Reset every piece of per-loop scratch state a new (or recovered) loop must
 * not inherit. ONE helper, called by every loop entry point, so the next entry
 * point cannot forget a field: `armedPass`/`fanoutStage` were reset only on a
 * stage transition, and a loop stopped mid-fan-out left `fanoutStage` armed —
 * loop B's first REVIEW then read `freshStage === false` and silently skipped
 * `runStageChecks` for the whole stage (no evidence seed, no check floor),
 * while a straggler verdict could be admitted against the stale pass's
 * narrowed axes.
 */
const resetLoopScratch = (): void => {
  samples = []
  checksInfo.clear() // per-run like the samples it annotates
  pending = null
  verdictRetried = false
  verdictRejected = null
  blocked = null // no blocked signal may outlive the run that recorded it
  drifted = null // a drift report belongs to the run that observed it, not the next one
  buildNoteFor = null
  armedPass = null
  fanoutStage = null
}
let buildNoteFor: string | null = null // `<taskId>:<iteration>` the "BUILD started" note was appended for — a same-stage re-fire must not duplicate it
let samples: StageSample[] = [] // per-run metrics
// Check-command provenance per stage (this host runs one loop at a time), for
// the stage's verdict sample and the once-per-run degradation note. Twin of
// the OpenCode driver's `stageChecksInfo`.
const checksInfo = new Map<string, { source: ChecksSource; ran: number; refused: number; detail: string; noted: boolean }>()
let lastFireAt = Date.now()
/**
 * Size of the prompt this server last handed out for a REAL fire, and how much a
 * stage context budget elided from it. This host cannot see the prompt at the
 * point it records a metrics sample (it was returned to the orchestrator turns
 * earlier), so the value is captured at the fire boundary instead.
 *
 * Deliberately NOT written by `workflow_compose`: that is an agent-callable,
 * idempotent read tool that can fire arbitrarily often and can name a stage that
 * is not the active one, so letting it write would make `promptChars` mean "the
 * last thing anyone asked to look at". Reset wherever a stage is fired without
 * this server composing, so a stale value is never misattributed.
 */
let lastFirePromptChars: number | undefined
let lastFirePromptElided: number | undefined
let stageDeadline: number | null = null // wall-clock cap for the stage in flight
let config: Config = DEFAULT_CONFIG

/**
 * Structured twin of the run-log summary — `runs/<id>.metrics.json`. The
 * Claude host never calls the LLM itself (stages run as agent turns), so its
 * entries carry timing/verdicts only; tokens for these runs are joined from
 * the session transcripts by consumers. Best-effort.
 */
const writeRunMetrics = (id: string, outcome: Outcome, detail: string, endedAt: string, retryable?: boolean): void => {
  try {
    const file = metricsPath(directory, config.tasksDir, id)
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    // Upsert: replace the trailing `open` entry the per-stage flush left behind.
    fs.writeFileSync(
      file,
      upsertRunMetrics(existing, {
        endedAt,
        outcome,
        detail,
        host: HOST,
        kind: active?.kind ?? "engineering",
        ...(retryable !== undefined ? { retryable } : {}),
        samples,
      }),
    )
  } catch {
    /* telemetry never fails the loop */
  }
}

/**
 * Flush samples-so-far as an `open` entry mid-run, so the hub shows token
 * usage accruing per stage instead of only at termination. Synchronous write →
 * no race with the terminal `writeRunMetrics`. Best-effort: never fails the loop.
 */
const flushRunMetrics = (id: string): void => {
  if (samples.length === 0) return
  try {
    const file = metricsPath(directory, config.tasksDir, id)
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    fs.writeFileSync(
      file,
      upsertRunMetrics(existing, {
        endedAt: new Date().toISOString(),
        detail: "",
        host: HOST,
        kind: active?.kind ?? "engineering",
        samples,
        open: true,
      }),
    )
  } catch {
    /* telemetry never fails the loop */
  }
}

/** Last-appended skip-set key — event-log flood control (one loop per server). */
let lastSkipEventKey: string | null = null

/** `Omit` that distributes over the SchedulerEvent union (a plain Omit collapses it to the common keys). */
type SchedEventBody = SchedulerEvent extends infer E ? (E extends SchedulerEvent ? Omit<E, "at" | "host" | "pid"> : never) : never

/** Best-effort scheduler-event append, stamped with this host's identity. */
const emitSchedEvent = (event: SchedEventBody): Promise<void> =>
  appendSchedulerEvents(sh, directory, config.tasksDir, [
    { at: new Date().toISOString(), host: HOST, pid: process.pid, ...event } as SchedulerEvent,
  ])

const loadCfg = async () => {
  try {
    config = await loadConfig(fsClient, directory)
  } catch (err) {
    await log("warn", `using default config: ${(err as Error).message}`)
    config = DEFAULT_CONFIG
  }
}

// --- host wiring (shared helpers live in @agentic-workflow/core/workflow/orchestrate) ---

/**
 * Which host is driving this server. One binary serves both Claude Code and
 * Qwen Code: they run the same state machine over the same manifests and differ
 * only in how a subagent is named, which marker file their hooks read, whether
 * their spawn tool takes a model, and the prose that instructs the spawn. Those
 * four live in HOST_DIALECT below and nowhere else — anything that starts to
 * vary belongs there too, not in an `if` at the call site.
 *
 * A set-but-unrecognized value throws at load rather than defaulting: on the
 * wrong dialect every spawn silently targets a subagent_type that does not
 * exist, which reads as "the loop is broken" long after the typo. Empty is
 * treated as absent, not as a typo — shell wrappers and installers propagate
 * empty env vars routinely, and refusing to boot on one would be noise.
 */
const HOSTS = ["claude", "qwen"] as const
type HostName = (typeof HOSTS)[number]
const rawHost = process.env.AGENTIC_WORKFLOW_HOST || undefined
if (rawHost !== undefined && !HOSTS.includes(rawHost as HostName)) {
  throw new Error(`AGENTIC_WORKFLOW_HOST="${rawHost}" is not a known host — expected one of: ${HOSTS.join(", ")}`)
}
const HOST: HostName = (rawHost as HostName | undefined) ?? "claude"

interface HostDialect {
  /** The subagent identifier the orchestrator hands its spawn tool. */
  readonly agentRef: (name: string) => string
  /** Whether the spawn tool takes a per-call model, i.e. whether a payload's
   *  `model` field is actionable at all on this host. */
  readonly conveysStageModel: boolean
  /** Names the spawn tool explicitly, so the `agent` field is not mis-routed. */
  readonly spawnToolNote: string
  /**
   * States that the configured stage model is already bound; "" on a host that
   * cannot convey one.
   *
   * A DECLARATION, not an instruction. The binding itself is the PreToolUse
   * stamp (hooks/src/stamp-spawn-model.entry.mjs), so nothing here has to be
   * obeyed — which is the point, because the instruction form was ignored and
   * every stage silently ran the host default. It stays because it is the only
   * observability there is: if the hook ever stops firing (a marker write that
   * failed, another spawn-tool rename), the transcript shows a stated model that
   * does not match the model the subagent actually ran on. Delete it and that
   * regression is invisible again.
   */
  readonly spawnModelNote: string
  /**
   * The host's structured question tool, named by every gate `next:` string.
   *
   * This was the literal `AskUserQuestion` for as long as Claude Code was the
   * only host reading these strings — and the same binary serves Qwen, so its
   * plan and ship gates were pointing the orchestrator at a tool that does not
   * exist there while the Qwen verb prose correctly said `ask_user_question`.
   * A gate ask does not fail loudly when it names the wrong tool; it just never
   * opens a window. Same split, same reason, as gen-prompts.mjs's {{askTool}}.
   */
  readonly askTool: string
}

// A stage agent is a subagent, not a skill. Name the tool explicitly at the
// spawn instruction: the host otherwise mis-routes the `agent`-field name to the
// skill tool (primed by skill-first rules and the real skills spawned the same turn).
const HOST_DIALECT: Record<HostName, HostDialect> = {
  claude: {
    // Plugin-bundled agents resolve under the plugin namespace in Claude Code —
    // Task's subagent_type is "agentic-workflow:<name>", not the bare manifest
    // name. The manifests stay host-neutral; only this host prefixes.
    agentRef: (name) => `agentic-workflow:${name}`,
    conveysStageModel: true,
    spawnToolNote:
      " (spawn it with the Task tool — a stage agent is a Task subagent, never a skill; do not route it through the skill tool)",
    spawnModelNote:
      ", whose `model` the harness has already pinned to this response's `model` field when present (you do not need to pass it)",
    askTool: "AskUserQuestion",
  },
  qwen: {
    // Qwen Code loads subagents from its own agents/ directory with no namespace,
    // so the manifest name is already the subagent_type.
    agentRef: (name) => name,
    // Qwen's `agent` tool has NO model parameter. Rather than emit a `model` the
    // orchestrator cannot act on, this host drops it from every payload and the
    // configured stage model is baked into the installed agent file at install
    // time (scripts/qwen-agents.mjs). The empty note below is that decision, not
    // an omission — see docs/design/qwen-host-support.md, gap 1.
    conveysStageModel: false,
    spawnToolNote:
      " (spawn it with the `agent` tool, passing the name as `subagent_type` and `run_in_background: false` — a stage agent is an `agent` subagent, never a skill; do not route it through the skill tool)",
    spawnModelNote: "",
    askTool: "ask_user_question",
  },
}
const dialect = HOST_DIALECT[HOST]

const stageMarkerPath = () => hostStageMarkerPath(directory, config.tasksDir, HOST)
const verdictNagPath = () => hostVerdictNagPath(directory, config.tasksDir, HOST)
const stageEvidencePath = () => hostStageEvidencePath(directory, config.tasksDir, HOST)

/**
 * What the PreToolUse guard recorded this check stage doing — the only account
 * of the stage's work the stage itself did not write (hooks/src/evidence.mjs).
 *
 * Null, never an empty observation set, when the ledger is missing, unreadable,
 * or belongs to another stage: those all mean "this host did not observe", and
 * `evidenceIssue` treats them as a reason to fall back to the declared-evidence
 * rule. An empty set means "the stage did nothing", which rejects a PASS — so
 * conflating the two would fail every stage on a repo whose hooks are not
 * installed.
 */
const observedEvidence = (stage: string): ObservedEvidence | null => {
  try {
    // The ledger is NDJSON — one line per observed tool call, appended by
    // concurrent hook processes (hooks/src/evidence.mjs `foldLedger` is the
    // reference fold; this is its TS twin). Lines from another stage and torn
    // lines are skipped; the legacy single-blob format folds for free (one
    // JSON line of the same shape).
    const raw = fs.readFileSync(stageEvidencePath(), "utf8")
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
    const commands: string[] = []
    const reads: string[] = []
    let observed = false
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (!t) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(t)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).stage !== stage) continue
      observed = true
      commands.push(...list((parsed as Record<string, unknown>).commands))
      reads.push(...list((parsed as Record<string, unknown>).reads))
    }
    if (!observed) return null
    // The driver-run check commands are NOT merged in here: they reach
    // admission as `EvidenceContext.seeded` (built at the workflow_verdict call
    // site), where they defeat the "did nothing" rejection — trusting them
    // instead of re-running them is correct — without being able to corroborate
    // a PASS on their own. Merged into `observed`, a stage that ran and read
    // nothing itself could cite the pre-run check command and pass the gate.
    return { commands: [...new Set(commands)], reads: [...new Set(reads)] }
  } catch {
    return null
  }
}

const agentRef = (name: string): string => dialect.agentRef(name)

/**
 * The stage's configured model in this host's SPAWN vocabulary (config >
 * manifest, undefined ⇒ host default).
 *
 * Resolves to an ALIAS (`sonnet`/`opus`/`haiku`/`fable`), not a model id,
 * because that is the only thing Claude Code's spawn tool accepts — it
 * validates `model` against that enum and errors the WHOLE spawn on a miss
 * rather than falling back. This used to emit `bareModel(m)`, so any config
 * naming a real model id (`anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`)
 * described a call the tool would reject; it stayed invisible only because the
 * prose carrying it was being ignored, which is the very defect the stamping
 * hook removes. An unmappable value resolves to undefined so the spawn is left
 * on the host default instead of being failed.
 *
 * Undefined on a host whose spawn tool takes no model: emitting a `model` the
 * orchestrator has nowhere to put invites it to improvise one. Every payload
 * spreads this conditionally, so suppressing it here removes the field
 * everywhere without touching a call site.
 */
const stageModel = (kind: string, def: StageDef): string | undefined => {
  if (!dialect.conveysStageModel) return undefined
  return spawnAlias(modelFor(config, kind, def)) ?? undefined
}

/**
 * Every agent this kind's manifest binds, mapped to the model it must run with.
 *
 * Parked on the stage marker for the PreToolUse stamp, which cannot resolve it
 * itself: `manifest/dir.ts` locates the workflows dir from `import.meta.url`,
 * and `build-hooks.mjs` inlines core into each bundle, so that walk lands on the
 * hook's own directory. The server already owns the resolution, so it answers
 * once and parks it — the same reason the marker carries `bashAllowlist`.
 *
 * A MAP over the whole kind, not the current stage's single value, ON PURPOSE:
 * `workflow_advance` returns the NEXT stage's fire payload WITHOUT rewriting the
 * marker (it defers to `workflow_stage`). A current-stage field would therefore
 * be stale for exactly the spawn that follows an advance, so a VERIFY-FAIL →
 * BUILD re-fire would silently drop BUILD's configured model from iteration 2
 * onward. Keyed by agent, staleness stops mattering.
 *
 * Cross-kind ambiguity (workflow-verify backs a stage in four kinds) cannot
 * arise here: a marker belongs to one active loop of one kind.
 */
const stageAgentModels = (m: LoadedManifest): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const def of m.manifest.stages) {
    if (!def.agent) continue
    const model = stageModel(m.manifest.kind, def)
    if (model) out[def.agent] = model
  }
  return out
}

/**
 * Every agent this kind's manifest binds — the set the PreToolUse spawn guard
 * (check-spawn-stage) asks "is this a stage agent of the loop that is running?".
 *
 * Parked here for the same reason as `stageAgentModels`: a bundled hook cannot
 * load a manifest, so the server answers once and the marker carries it.
 *
 * It is a WHOLE-KIND set, and the marker's per-arming `agent` field is what says
 * which one may be spawned right now. Both are needed and neither substitutes for
 * the other: without the set the guard cannot tell a stage agent from
 * `workflow-task-author`, and would deny spawns that were never part of the
 * protocol; without `agent` it cannot tell the armed stage from its siblings,
 * which is the whole check. Unlike `agent`, this set cannot go stale within a run
 * — a marker belongs to one loop of one kind. Pure.
 */
const stageAgents = (m: LoadedManifest): string[] => [...new Set(m.manifest.stages.flatMap((def) => (def.agent ? [def.agent] : [])))]

/**
 * The focused passes a stage runs, in order. Takes the kind explicitly rather
 * than reading `activeManifest()`: `firePayload` composes for a state that is
 * not the active loop yet.
 */
const passesFor = (kind: string, def: StageDef): readonly StagePass[] => stagePasses(config, kind, def)

/** The focus labels of a stage's passes — empty when it runs as a single pass. */
const passLabels = (kind: string, def: StageDef): string[] => passesFor(kind, def).flatMap((p) => (p.focus ? [p.focus] : []))

/** Focus names are matched normalized, so a capitalization slip is not a rejection loop. */
const focusKey = (focus: string): string => focus.trim().toLowerCase()

/**
 * The pass `workflow_verdict` should admit against right now. Falls back to the
 * unfocused pass when nothing is armed, which is what every single-pass stage
 * (and every stage on a host that ignores `focus`) gets.
 */
const currentPass = (stage: string): StagePass =>
  armedPass?.stage === stage ? armedPass.pass : { focus: null, mode: "single" }

/**
 * A `stageModels` key naming no stage of its kind is accepted by the schema
 * (the manifest isn't loaded at parse time) and then resolves to nothing —
 * the stage silently runs the host default. Surface it instead of leaving the
 * user to conclude model selection is broken. Best-effort: an unreadable
 * manifest must never block a claim.
 */
const stageModelWarnings = (): string[] =>
  enabledWorkflowKinds(config).flatMap((kind) => {
    let stageNames: string[]
    try {
      stageNames = manifestFor(kind).manifest.stages.map((s) => s.name)
    } catch {
      return []
    }
    const unknown = unknownStageModelKeys(config, kind, stageNames)
    const warnings = unknown.length
      ? [
          `workflows.${kind}.stageModels names ${unknown.map((k) => `"${k}"`).join(", ")}, which ${unknown.length > 1 ? "are" : "is"} not a stage of the ${kind} loop — ` +
            `${unknown.length > 1 ? "those overrides are" : "that override is"} ignored and the stage runs the host default model. Valid stages: ${stageNames.join(", ")}.`,
        ]
      : []
    // Same silent-default trap for a stageContext key: a typo'd stage — or a
    // typo'd artifact inside a valid stage — leaves that prompt unbounded, which
    // reads as "the budget did nothing".
    const unbudgeted = unknownStageContextKeys(config, kind, stageNames)
    if (unbudgeted.length) {
      warnings.push(
        `workflows.${kind}.stageContext names ${unbudgeted.map((k) => `"${k}"`).join(", ")}, which ${unbudgeted.length > 1 ? "are" : "is"} not a stage of the ${kind} loop — ` +
          `${unbudgeted.length > 1 ? "those budgets are" : "that budget is"} ignored and the prompt stays unbounded. Valid stages: ${stageNames.join(", ")}.`,
      )
    }
    // A lens list suppresses per-pass axis-coverage enforcement, and the
    // stage-wide check only survives when the lenses between them span the
    // stage's axes — so name the axes no lens covers, and say what that costs.
    // A ONE-entry list is the shape most likely to be hand-written, and it is
    // the one that costs the most: the unfocused single pass it replaces was
    // admitted against every axis.
    for (const def of manifestFor(kind).manifest.stages) {
      const unreviewed = unreviewedAxes(config, kind, def)
      if (!unreviewed.length) continue
      warnings.push(
        `workflows.${kind}.stageFanout.${def.name} is a lens list and no lens covers ` +
          `${unreviewed.map((a) => `"${a}"`).join(", ")}, so the ${kind} loop's ${def.name} stage does not enforce axis ` +
          `coverage at all — ${unreviewed.length > 1 ? "those axes go" : "that axis goes"} unreviewed. Add ` +
          `${unreviewed.length > 1 ? "those lenses" : "that lens"} to get the coverage check back, or set it to "axis" ` +
          "to cover and enforce every required axis.",
      )
    }
    // Same trap for stageChecks, and a worse one to hit: a typo'd stage runs NO
    // check commands, so the loop quietly goes back to a self-reported "green".
    const unchecked = unknownStageCheckKeys(config, kind, stageNames)
    if (unchecked.length) {
      warnings.push(
        `workflows.${kind}.stageChecks names ${unchecked.map((k) => `"${k}"`).join(", ")}, which ${unchecked.length > 1 ? "are" : "is"} not a stage of the ${kind} loop — ` +
          `${unchecked.length > 1 ? "those check commands are" : "that check command is"} never run. Valid stages: ${stageNames.join(", ")}.`,
      )
    }
    // stageConcurrency is an OpenCode-only knob, and silence would read as
    // "parallel passes are on". They are not, and cannot be here: this host's
    // orchestrator spawns the pass subagents while the server keeps ONE armed
    // pass, one stage marker and one evidence ledger — all three read by the
    // PreToolUse/SubagentStop hooks — so a pass has no identity to attribute a
    // verdict, a marker or a tool call to.
    const concurrent = concurrentStages(config, kind, stageNames)
    if (concurrent.length) {
      warnings.push(
        `workflows.${kind}.stageConcurrency asks ${concurrent.map((s) => `"${s}"`).join(", ")} to run passes concurrently, ` +
          `which this host does not do — the passes run one at a time. That knob is honored by the OpenCode plugin only.`,
      )
    }
    const unknownConc = unknownStageConcurrencyKeys(config, kind, stageNames)
    if (unknownConc.length) {
      warnings.push(
        `workflows.${kind}.stageConcurrency names ${unknownConc.map((k) => `"${k}"`).join(", ")}, which ${unknownConc.length > 1 ? "are" : "is"} not a stage of the ${kind} loop — ` +
          `ignored. Valid stages: ${stageNames.join(", ")}.`,
      )
    }
    // Same trap once more for stageFanout: a typo'd stage never fans out.
    const unfanned = unknownStageFanoutKeys(config, kind, stageNames)
    if (unfanned.length) {
      warnings.push(
        `workflows.${kind}.stageFanout names ${unfanned.map((k) => `"${k}"`).join(", ")}, which ${unfanned.length > 1 ? "are" : "is"} not a stage of the ${kind} loop — ` +
          `${unfanned.length > 1 ? "those are" : "that is"} ignored and the stage runs a single pass. Valid stages: ${stageNames.join(", ")}.`,
      )
    }
    return warnings
  })

/**
 * The agents `agentModels` may name: every agent some enabled kind's manifest
 * binds, plus the two that are spawned OUTSIDE any stage (the drafting author
 * and the ad-hoc planner) and so have no StageDef to inherit from.
 */
const knownAgentNames = (): string[] => {
  const names = new Set(["workflow-task-author", "workflow-plan"])
  for (const kind of enabledWorkflowKinds(config)) {
    try {
      for (const def of manifestFor(kind).manifest.stages) if (def.agent) names.add(def.agent)
    } catch {
      /* a kind whose manifest won't load is reported elsewhere */
    }
  }
  return [...names]
}

/**
 * `agentModels` misconfigurations, which became worth reporting the moment the
 * binding stopped being advisory: with the PreToolUse stamp enforcing it, the
 * only remaining ways a configured agent still runs the host default are a name
 * that matches no agent, or a value this host cannot express.
 */
const agentModelWarnings = (): string[] => {
  const warnings: string[] = []
  const unknown = unknownAgentModelKeys(config, knownAgentNames())
  if (unknown.length) {
    warnings.push(
      `agentModels names ${unknown.map((k) => `"${k}"`).join(", ")}, which ${unknown.length > 1 ? "are" : "is"} not an agent this plugin ships — ` +
        `${unknown.length > 1 ? "those entries are" : "that entry is"} ignored and the spawn runs the host default model.`,
    )
  }
  // Claude Code's spawn tool takes an alias (sonnet/opus/haiku/fable), while the
  // config schema accepts any string because OpenCode needs real provider/model
  // ids. A value naming no known family is valid config this host cannot act on,
  // and it is left unstamped rather than passed through — passing it would fail
  // the tool's schema and error the whole spawn.
  if (dialect.conveysStageModel) {
    for (const [agent, model] of unbindableAgentModels(config)) {
      warnings.push(
        `agentModels.${agent} is "${model}", which does not name a model family this host's spawn tool understands ` +
          `(it accepts sonnet, opus, haiku, or fable) — that spawn runs the host default model.`,
      )
    }
  }
  return warnings
}

const SPAWN_MODEL_NOTE = dialect.spawnModelNote
const SPAWN_TOOL_NOTE = dialect.spawnToolNote

/** A check stage's non-negotiable extra: the subagent, not the orchestrator, records the verdict. */
const CHECK_VERDICT_TAIL =
  " — it is a check stage: the spawned subagent MUST call the workflow_verdict MCP tool before returning; " +
  "a verdict in prose is ignored. Never call workflow_verdict yourself on its behalf."

/**
 * Compose a spawn instruction. EVERY note that tells the orchestrator to spawn a
 * stage subagent is built here, never hand-written at the call site: the fire
 * payloads have always carried the configured stage model, but a note naming only
 * `agent` let `workflows.<kind>.stageModels` be dropped at every hop, and every
 * stage ran the host default. The note at the point of use is what the orchestrator
 * acts on, so the model clause must be impossible to leave out — one composer, and
 * a source lint (server.test.ts) that no spawn note bypasses it.
 *
 * Both clauses come from HOST_DIALECT, so a host whose spawn tool takes no model
 * contributes an empty model clause *by declaring one* — the composer still
 * splices it, and the lint still proves no note skips the composer.
 *
 * `lead` says what to spawn; `tail` adds the per-site consequence.
 */
const spawnNote = (lead: string, tail = ""): string => `${lead}${SPAWN_TOOL_NOTE}${SPAWN_MODEL_NOTE}${tail}`

/**
 * Temp+rename write for the stage marker. The PreToolUse hook is a separate
 * process; a `writeFileSync` straight onto the marker path opens a
 * truncate-to-write window, and the hook's reader (marker.mjs) returns null on
 * any parse failure — which the guard treats as "no loop stage" and ALLOWS. A
 * torn read therefore skips the check-stage allowlist, the worktree pin, and
 * the stage deadline for that call, with every layer reporting success. Same
 * durability story as OpenCode's writeOpencodeStageMarker (temp + rename).
 */
const writeMarkerAtomic = (file: string, content: string): void => {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

/** Flip the stage marker's `verdictRecorded` flag in place once workflow_verdict
 *  lands, so the SubagentStop guard (check-verdict-guard.mjs) stops nagging. */
const stampVerdictRecorded = () => {
  try {
    const m = JSON.parse(fs.readFileSync(stageMarkerPath(), "utf8")) as Record<string, unknown>
    writeMarkerAtomic(stageMarkerPath(), JSON.stringify({ ...m, verdictRecorded: true }))
    fs.rmSync(verdictNagPath(), { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Write the current-stage marker the PreToolUse hook reads to scope the
 * allowlist and enforce the stage deadline. Returns null on success, or the
 * failure reason.
 *
 * It used to swallow every error, and `workflow_stage` returned success
 * regardless. A failed write (read-only mount, ENOSPC, EACCES on a runs/ dir
 * another user created, a tasksDir on a flaky network mount) therefore left the
 * PREVIOUS stage's marker in place: a check stage then ran under BUILD's
 * unrestricted allowlist, with the one deterministic backstop this host has
 * (threat-model T8/T1) silently gone and every layer reporting OK.
 *
 * So a failure is reported to the caller, and the stale marker is removed first
 * — no marker means "no loop stage", which the guard treats as an ordinary
 * session, and that is strictly safer than an armed marker describing a stage
 * that is not the one about to run.
 *
 * `deadline` (absolute ms) overrides the computed stage deadline for the one
 * caller that knows better: `runStageChecks` advertises the CHECK-PHASE budget
 * before the first check runs, so `taskDrivenByStageMarker` never reads a live
 * run's expired previous-stage deadline as crash evidence mid-phase. The
 * ordinary per-pass arming passes nothing and keeps today's math.
 */
const writeStageMarker = (stage: string | null, deadline?: number): string | null => {
  const dir = path.join(directory, config.tasksDir, "runs")
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.rmSync(verdictNagPath(), { force: true }) // the nag sentinel belongs to one stage attempt only
    // Likewise the evidence ledger: a stage attempt may only be corroborated by
    // its OWN work. Carrying a previous attempt's commands forward would let a
    // re-fired check PASS on the work of the attempt that failed.
    fs.rmSync(stageEvidencePath(), { force: true })
    drifted = null // likewise the drift record: one note (and one report) per stage attempt, not one per run
    if (stage === null) {
      stageDeadline = null
      fs.rmSync(stageMarkerPath(), { force: true })
    } else {
      const m = activeManifest()
      const def = stageDef(m.manifest, stage)
      stageDeadline = deadline ?? Date.now() + (def.timeoutMinutes ?? config.stageTimeoutMinutes) * 60_000
      // The platform stamped into the state at claim time wins over the live
      // config: prompt guidance renders from the same stamp, and a config flip
      // mid-loop must not strand a claimed PR with an allowlist that contradicts
      // its prompt.
      // Write the allowlist for EVERY stage that declares one, not just check
      // stages: pr-sitter `publish` is a WORK stage whose allowlist ("git push"
      // + "gh pr comment", never "gh pr merge") is this host's only deterministic
      // "never merge / never mutate the PR" backstop (threat-model T8/T1). A stage
      // that declares none (engineering plan/build, pr-sitter fix) writes no list
      // and stays unrestricted — those stages must write code freely.
      const platform = active?.platform ?? platformFor(config, m.manifest.kind)
      // `bashAllowlistExtra` extends only stages that DECLARE an allowlist: an
      // empty base means the stage is unrestricted, and appending extras there
      // would restrict it to just the extras. No `cd * && ` twins here — this
      // host's guard matches per segment, not the whole command string.
      //
      // `bashAllowlistPrefix` re-expresses that same list behind a rewriting
      // proxy (`npm test*` → also `rtk npm test*`), so a stage keeps its own
      // boundary instead of needing a blanket `"rtk *"` extra. The prefixes
      // themselves ride the marker too: the guard strips them before the write
      // backstops classify a segment, and a bundled hook can read neither the
      // config nor a manifest.
      const prefixes = bashAllowlistPrefixes(config)
      // `stageBashGlobs` owns the composition (base + extras + prefix twins, and
      // the empty-base rule that keeps an allowlist-less stage unrestricted), so
      // doctor's deny report can be judged against the very list written here.
      const allowlist = stageBashGlobs(def, platform, config)
      const stageAgentModelMap = stageAgentModels(m)
      writeMarkerAtomic(
        stageMarkerPath(),
        JSON.stringify({
          kind: m.manifest.kind,
          stage,
          // The guard's ADO checks key off this.
          platform,
          // The Azure DevOps MCP tools THIS stage may call, resolved from the
          // manifest here because a bundled hook cannot read manifests
          // (`manifest/dir.ts` resolves from import.meta.url, which lands in the
          // hook's own directory once esbuild inlines core). Stage-keyed, and
          // rewritten on every stage fire — a stale list would grant the next
          // stage this one's budget.
          adoTools: effectivePlatformTools(def, platform),
          // The subagent this stage binds, straight from the manifest — the driver
          // (workflow-orchestration SKILL) spawns whatever is named here, so a new kind
          // needs no prose edit. Also the ARMED agent the spawn guard admits: on a
          // host with no driver, spawning any other stage agent of this kind means a
          // workflow_advance/workflow_stage call was skipped.
          agent: def.agent,
          // The rest of this kind's stage agents, so the guard can tell a sibling
          // stage's agent (deny — the protocol was skipped) from an agent that is
          // not part of the loop at all (allow). See stageAgents().
          kindAgents: stageAgents(m),
          // Check stages must record a verdict via workflow_verdict before ending;
          // the SubagentStop guard blocks a first stop that hasn't (see
          // check-verdict-guard.mjs). workflow_verdict flips verdictRecorded in place.
          check: def.kind === "check",
          verdictRecorded: false,
          // The backlog guard's PLAN carve-out: only this task's queued/ file
          // may be written directly while PLAN is live.
          taskId: active?.task?.id ?? null,
          // The worktree THIS stage is pinned to — null for a stage declaring
          // `isolation: "none"` (engineering plan), which runs in the main tree.
          worktree: def.isolation === "none" ? null : (active?.git?.worktree ?? null),
          // The worktree the LOOP owns, regardless of this stage's isolation.
          // An unisolated stage still must not write code into the human's
          // checkout — without this the guard saw no worktree at all and waved
          // every PLAN-stage write through onto the current branch.
          workflowWorktree: active?.git?.worktree ?? null,
          deadline: stageDeadline,
          // Lets `taskDrivenByStageMarker` treat a SIGKILLed server's leftover
          // marker as dead instead of blocking recover for the stage window.
          pid: process.pid,
          // 1-indexed to match the "BUILD started (iteration N)" audit notes.
          iteration: active ? active.iteration + 1 : null,
          ...(allowlist.length ? { bashAllowlist: allowlist } : {}),
          // The configured proxy prefixes, for the guard's write-backstop strip.
          // Absent (unset key, older server) ⇒ no strip ⇒ exactly the previous
          // behaviour, the fail-open direction every hook input here takes.
          ...(prefixes.length ? { bashPrefix: prefixes } : {}),
          // The repo's extra protected branches, stamped for the same reason.
          // Absent ⇒ the guard keeps only its permanent main/master/HEAD floor.
          ...(config.protectedBranches?.length ? { protectedBranches: config.protectedBranches } : {}),
          // Consumed by the PreToolUse spawn-model stamp; see stageAgentModels().
          ...(Object.keys(stageAgentModelMap).length ? { stageAgentModels: stageAgentModelMap } : {}),
        }),
      )
    }
    return null
  } catch (err) {
    // Never leave the previous stage's marker armed for a stage it does not
    // describe — that is how a check stage inherited BUILD's allowlist.
    try {
      stageDeadline = null
      fs.rmSync(stageMarkerPath(), { force: true })
    } catch {
      /* the report below is what matters */
    }
    return (err as Error).message
  }
}

/** A stage past its wall-clock cap must fail the loop rather than wedge it. Pure. */
const isOverdue = (deadline: number | null, now: number): boolean => deadline !== null && now > deadline

const snapshot = async () => {
  if (active?.task) await saveState(sh, directory, config.tasksDir, active.task.id, active, log)
}

const workTree = () => (active ? workflowWorkTree(directory, active) : directory)

/** The manifest driving the active loop (engineering when kind is absent). */
const activeManifest = (): LoadedManifest => manifestFor(active?.kind ?? "engineering")

/** Serialize a value into an MCP text result. */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] })

/**
 * The shared gate context for this host. `isDriving` defaults to the single
 * in-memory `active` loop; the replan/reject paths override it with the id a
 * live loop is driving (the MCP tool's `active`, or the CLI's on-disk marker).
 */
/**
 * The Azure DevOps MCP gateway as a spreadable fragment — `{}` when ADO isn't
 * configured, so a GitHub-only install never carries the key or spawns a
 * server. One server per process; see `sharedAdoGateway`.
 */
const adoGatewayDep = (): { adoGateway?: AdoGateway } => {
  const gateway = sharedAdoGateway(config, log)
  return gateway ? { adoGateway: gateway } : {}
}

/**
 * Per-command cap on the shell a gate verb runs — design 21's bound, extended
 * to this host (it stopped at OpenCode, and the hang class is host-agnostic: a
 * gate move on a slow tree left the MCP call `running` forever with the
 * orchestrator's turn wedged behind it). Generous on purpose: the slowest
 * legitimate gate command is the ship's `git push` / `gh pr create`, and
 * cutting one short costs a caveated ship a human can finish by hand — where
 * NOT capping cost a call that never returned. The shim's `.timeout` kills the
 * child and resolves exit 124 (`timeout(1)`'s convention), which core reads as
 * an ordinary failed command: the move still reports, only the best-effort
 * bookkeeping is skipped. Deliberately NOT applied to the plain `sh`:
 * checkpoint commits, worktree setup and `runChecks` legitimately run long and
 * carry their own regime. (No core gate path calls `.timeout` itself, so the
 * initial cap is never widened; a caller that did would narrow via the shim.)
 */
const GATE_SHELL_TIMEOUT_MS = 60_000
const boundedGateSh: typeof sh = (strings, ...exprs) => {
  // `.timeout` is optional on the host interface; this shim always ships it,
  // but degrade to the unbounded call rather than crash if that ever changes.
  const p = sh(strings, ...exprs)
  return p.timeout?.(GATE_SHELL_TIMEOUT_MS) ?? p
}

const gateCtx = (): GateCtx => ({ $: boundedGateSh, client: fsClient, log, directory, config, isDriving: (id) => active?.task?.id === id, ...adoGatewayDep() })

/**
 * The shared terminal context for this host — the ports core's `runTerminal`
 * needs. Backlog commits and checkpoints go straight through `commitPaths`/
 * `commitAll` (no per-tree lock: the pull host drives one loop at a time), and
 * metrics render into this host's run log + `host: <HOST>` sidecar.
 */
const terminalCtx = (state: WorkflowState, actor: string | null): TerminalCtx => ({
  $: sh,
  log,
  directory,
  config,
  state,
  manifest: manifestFor(state.kind ?? "engineering"),
  actor,
  // Core's `runTerminal` gates on `ignoreBacklog` before calling this port; going
  // through core's own helper anyway keeps the policy in the one place `gate.ts`
  // says it lives, so no host site carries a second copy of it.
  commitBacklog: async (message) => void (await coreCommitBacklog(sh, directory, config, message)),
  // Worktree checkpoints exclude the backlog dir — the frozen `<tasksDir>` copy
  // must never ride feature/<id> (task-file lifecycle lives on the main tree).
  checkpoint: async (message) =>
    void (await commitAll(sh, workflowWorkTree(directory, state), message, state.git?.worktree ? [config.tasksDir, ...CHECKPOINT_LOCKFILE_EXCLUDES] : [...CHECKPOINT_LOCKFILE_EXCLUDES])),
  writeMetrics: async (outcome, detail, retryable) => {
    const stamp = new Date().toISOString()
    const summary = renderRunSummary(samples, outcome, detail, config.maxIterations, stamp, state.kind ?? "engineering")
    await appendRunLog(sh, directory, config.tasksDir, workflowId(state), `run · ${outcome}`, summary, log)
    writeRunMetrics(workflowId(state), outcome, detail, stamp, retryable)
  },
})

/** Locate which status folder a task id lives in. */
const findAnyStatus = (id: string): Promise<Task | null> => coreFindAnyStatus(gateCtx(), id)

/** The work sources workflow_claim polls, in claim-priority order (config order).
 *  An `only` kind restricts the poll to that one kind; a `target` PR number
 *  forces that exact PR on a PR-shaped `only` kind. */
const sourcesFor = (only?: string, target?: number): WorkSource[] =>
  buildWorkSources(
    // Single active loop per server; a claim only happens when no loop is live.
    { $: sh, client: fsClient, directory, log, isDriving: (id) => active?.task?.id === id, hostName: HOST, ...adoGatewayDep() },
    config,
    manifestFor,
    only,
    target,
  )

/** Claim an approved in-progress task and construct its build-entry state.
 *  Shared by workflow_start and workflow_claim. */
const startTask = async (t: Task): Promise<{ error: string } | { state: WorkflowState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  resetLoopScratch()
  // Only workflow_claim sets activeClaim; a stale one left by a claim flow that
  // died mid-setup would fire onTerminal against the WRONG work item at this
  // loop's end. A workflow_start loop has no scheduler claim behind it.
  activeClaim = null
  // Durable claim evidence BEFORE isolation cuts feature/<id>: everything after
  // this commits onto the loop branch, so without it the human branch's task
  // file looks untouched after teardown and the watcher re-claims a task whose
  // work already ran (see store.ts CLAIMED_MARKER).
  await markClaimed(sh, t, await gitActor(sh, directory), log)
  // Committed unconditionally — the one backlog commit that deliberately ignores
  // `ignoreBacklog`, written down because it looks exactly like the bookkeeping
  // sites that do respect it. This is not bookkeeping: it is what makes the claim
  // survive the branch switch. Under the policy a repo that TRACKS its backlog
  // would lose the note off the human branch (the loop's own `git add -A`
  // checkpoint sweeps it onto feature/<id>), teardown would leave the human branch
  // looking untouched, and the watcher would re-claim finished work. Under the
  // default (untracked backlog) it is already a no-op — `git add` refuses ignored
  // paths — so the exemption costs nothing where the knob is in force.
  await commitPaths(sh, directory, [config.tasksDir], `loop(${t.id}): claimed`)
  let state = buildEntryState(t)
  try {
    state = await ensureIsolation(sh, log, directory, config, state, await resolveBase())
  } catch (err) {
    // Died before any durable work (only the CLAIMED note exists — no BUILD
    // note yet), and the claim above is ours, so hand it back. Without this the
    // marker is wedged: the orphan sweep and workflow_doctor both refuse a body
    // carrying CLAIMED on purpose, so only a manual workflow_recover would free it.
    await releaseClaim(sh, t)
    return { error: (err as Error).message }
  }
  active = state
  await snapshot()
  return { state }
}

/** Claim a queued (planless) task and construct its PLAN-entry state. No git
 *  isolation and no snapshot: PLAN writes only the task file, in the main
 *  tree. A died PLAN leaves a stale marker in queued/.claims/ — the next claim
 *  walk releases it once it reads stale, or workflow_doctor fix does so now. */
const startPlan = async (t: Task): Promise<{ error: string } | { state: WorkflowState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  // Planning it by hand honours any hub plan request for it just as a claim
  // would, so the marker must not outlive this — otherwise the board keeps
  // showing "plan requested" for a task that is being planned right now.
  await consumePlanRequest(sh, directory, config.tasksDir, t.id, "queued")
  resetLoopScratch()
  activeClaim = null // see startTask — a workflow_start loop has no scheduler claim behind it
  const state = planEntryState(t)
  active = state
  // Arm the PreToolUse carve-out for the whole PLAN window: {stage:"plan", taskId}
  // so the workflow-plan-author subagent may Edit its own queued/<id>.md. The PLAN
  // path spawns the author straight off workflow_start without a workflow_stage call, so
  // without this the marker never exists and the one write PLAN exists to make is
  // blocked. workflow_advance clears it on park.
  // A failed arm here means the plan-author's one legal write (queued/<id>.md)
  // will be blocked by the guard, so say so rather than start a doomed PLAN.
  const markerError = writeStageMarker("plan")
  if (markerError) {
    active = null // never leave a loop marked live behind an unguarded stage
    // No PLAN ran, so this exit must hand back everything the claim took —
    // the same rule `startTask`'s isolation-failure arm follows, and for a
    // sharper reason here: a held `queued/.claims/<id>` asserts a LIVE loop, so
    // replan/abandon/remove all refuse the task and neither `claim` nor
    // `workflow_start` can re-acquire it until the stale sweep (~75 minutes at
    // the default stage timeout). The plan request goes back for the same
    // reason `source/backlog.ts`'s `release()` restores a spent one: nothing
    // was planned, so the human's ask still stands. Both best-effort — a
    // failure here must not mask the marker error the caller has to report.
    try {
      await releaseClaim(sh, t)
      await requestPlan(sh, directory, config.tasksDir, t.id, { status: "queued" })
    } catch (err) {
      await log("warn", `loop(${t.id}): could not hand the claim back after the PLAN marker failed — ${(err as Error).message}`)
    }
    return { error: `Could not arm the PLAN stage marker — ${markerError}. Check that ${config.tasksDir}/runs/ is writable.` }
  }
  return { state }
}

/**
 * Warnings a claim should surface: a live foreign watcher's lease (its git
 * operations can race this one-shot claim — threat-model T3 residual) and any
 * backlog anomalies the reconciliation sweep finds. Best-effort; never blocks.
 */
const claimWarnings = async (): Promise<string[]> => {
  const warnings: string[] = [...stageModelWarnings(), ...agentModelWarnings()]
  const owner = await readLeaseOwner(sh, directory, config.tasksDir)
  if (owner && !isLeaseStale(owner, new Date(), staleThresholdMs(owner.intervalMs))) {
    warnings.push(
      `a live watcher (pid ${owner.pid} on ${owner.host}) holds this clone's watch lease — ` +
        `one-shot claims can race its git operations; prefer running them in separate clones/worktrees.`,
    )
  }
  const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
  if (hasAnomalies(anomalies)) warnings.push(...formatAnomalies(anomalies, config.tasksDir).map((l) => `${l} (workflow_doctor repairs)`))
  return warnings
}

/**
 * Compose a stage prompt for an actual fire, recording its size for the pass's
 * metrics sample. `suffix` is host prose appended after composition (the
 * verdict-retry nag), counted because it is part of what the model receives.
 */
/**
 * Run a stage's declared check commands in the work tree and hang the results on
 * `active`, so the prompt composed next carries their exit codes as fact and the
 * finalizer can floor the verdict with them.
 *
 * Called from `workflow_stage` — after `ensureIsolation`, before the payload —
 * because that is this host's fire boundary; the prompt `workflow_advance`
 * composed one turn earlier could not have known them. Once per stage arming,
 * not once per focused pass: every lens of a review sees the same results, and
 * one review must not cost N test suites.
 */
const runStageChecks = async (state: WorkflowState, stage: string): Promise<WorkflowState> => {
  const dir = state.git?.worktree ?? directory
  const { defs, source, warnings, refused } = await resolveStageChecks({
    $: sh,
    config,
    kind: activeManifest().manifest.kind,
    def: stageDef(activeManifest().manifest, stage),
    // The plan the loop is running against — re-extracted from the task file at
    // claim time, so it is the same text on every iteration of this task.
    plan: state.artifacts.plan,
    dir,
  })
  // Warn, never fail: a dropped or refused discovered check must leave the loop
  // exactly as it was before discovery existed, or a bad plan block becomes a
  // stalled run. But record the provenance durably (sample fields + the note
  // below): the log line alone made a fully-refused fence indistinguishable,
  // on disk, from a plan that never declared one.
  for (const w of warnings) await log("warn", `${stage}: ${w}`)
  // Admission refusals reach the deny log too (source "check"), so doctor's
  // one telemetry view covers BOTH starvation seams — plan-named commands the
  // stage refused used to live only in warn lines and a conflated metric.
  for (const r of refused) {
    if (r.command) {
      appendDenyEntry(directory, config.tasksDir, {
        ts: new Date().toISOString(),
        host: HOST,
        kind: activeManifest().manifest.kind,
        stage,
        command: r.command,
        source: "check",
      })
    }
  }
  const prior = checksInfo.get(stage)
  const info = {
    source,
    ran: defs.length,
    // Admission refusals alone — parse issues and missing binaries stay in
    // `detail`, where they always were; they used to be conflated in here.
    refused: refused.length,
    detail: clampedChecksDetail(warnings),
    noted: prior?.noted ?? false,
  }
  checksInfo.set(stage, info)
  // Once per run, only when the outcome would otherwise be silent.
  // `checksProvenanceNote` owns the predicate and the phrasing for both hosts:
  // a fence whose commands are not what ran, and a discovering stage that ran
  // with no fence and zero commands (the run-time truth beside the park-time
  // forecast — a plan approved before the forecast shipped reaches this fire
  // with nothing on disk).
  const note = checksProvenanceNote({
    stage,
    source,
    ran: defs.length,
    refused: warnings.length,
    detail: info.detail,
    fencePresent: hasChecksFence(state.artifacts.plan ?? ""),
    discovering: discoverChecksFor(config, activeManifest().manifest.kind, stageDef(activeManifest().manifest, stage)),
  })
  if (!info.noted && state.task && note) {
    info.noted = true
    await appendNote(sh, state.task, auditNote(note, new Date(), await gitActor(sh, directory)), log)
  }
  // A zero-defs iteration must clear any PRIOR iteration's results for this
  // stage, not merely skip writing new ones — leaving `state.checks[stage]`
  // untouched lets a stale FAIL from an earlier run float forward and floor an
  // honest PASS this iteration never earned. `withCheckResults(state, stage,
  // [])` is identity for `finalizeCheckRecord` (empty results never floor) and
  // for the composed prompt (`ran?.length` is falsy either way) — so a task
  // that never had checks stays byte-identical, only a re-fire's staleness is
  // cleared.
  if (!defs.length) return withCheckResults(state, stage, [])
  // The phase below runs BEFORE this call's own marker arming and claim restamp
  // (both follow in workflow_stage), on a claim stamp as old as the previous
  // stage's whole runtime — and sequential checks legally compound past the
  // stale window. Mid-phase, both liveness oracles then read this LIVE run as
  // dead: the stale claim is swept by any rival walk, and the previous stage's
  // expired marker deadline is "crash evidence" to recover. So arm the marker
  // early with a deadline covering the whole check budget, restamp the claim
  // now, and restamp again before every check — the gap another process can
  // observe never exceeds one check's own cap. The per-pass arming that follows
  // re-writes the marker with the ordinary stage deadline.
  const markerError = writeStageMarker(stage, Date.now() + checksBudgetMs(defs, config.checkTimeoutMinutes * 60_000))
  if (markerError) await log("warn", `${stage}: could not advertise the check-phase deadline — ${markerError}`)
  await refreshWorkClaim(sh, state)
  const results = await runChecks(sh, defs, dir, config.checkTimeoutMinutes * 60_000, () => refreshWorkClaim(sh, state))
  for (const r of results) {
    if (r.outcome === "pass") continue
    await log("warn", `${stage} check "${r.name}" exited ${r.exitCode} (${r.command})`)
  }
  return withCheckResults(state, stage, results)
}

const firePrompt = (loaded: LoadedManifest, state: WorkflowState, stage: string, suffix = ""): string => {
  const { prompt, elided } = composePromptWithStats(loaded, state, stage, config)
  const fired = `${prompt}${suffix}`
  lastFirePromptChars = fired.length
  lastFirePromptElided = elided
  return fired
}

/** Record the size of a prompt handed out via a fire `Action` (the snapshot-resume path). */
const recordFiredAction = (action: Action): void => {
  if (action.kind !== "fire") return
  lastFirePromptChars = action.arguments.length
  lastFirePromptElided = action.promptElided
}

/** The recorded prompt size for the pass that just finished, if this server composed it. */
const promptSizeFields = (): { promptChars?: number; promptElided?: number } => ({
  ...(lastFirePromptChars !== undefined ? { promptChars: lastFirePromptChars } : {}),
  ...(lastFirePromptElided ? { promptElided: lastFirePromptElided } : {}),
})

/** The fire payload workflow_start/workflow_claim return for a fresh claim. */
const firePayload = (state: WorkflowState, id: string) => {
  const manifest = manifestFor(state.kind ?? "engineering")
  const def = stageDef(manifest.manifest, state.stage)
  const model = stageModel(manifest.manifest.kind, def)
  return {
    action: { kind: "fire", stage: state.stage },
    taskId: id,
    // The subagent to spawn for this stage — the manifest's name under the
    // plugin namespace (Task subagent_type). Fall back to the bare name only
    // if the namespaced one is unknown to this Claude Code version.
    agent: agentRef(def.agent),
    ...(model ? { model } : {}),
    isolation: state.git ?? null,
    prompt: firePrompt(manifest, state, state.stage),
    ...(passLabels(manifest.manifest.kind, def).length ? { passes: passLabels(manifest.manifest.kind, def) } : {}),
    // Every fired stage carries the spawn instruction, not just PLAN. A non-plan
    // entry (BUILD via workflow_start/workflow_claim; every sitter's entry stage)
    // used to arrive with `model` in the payload and nothing telling the
    // orchestrator to pass it — the payload's own field, silently dropped.
    note:
      state.stage === "plan"
        ? spawnNote(
            "PLAN stage: spawn the subagent named in the `agent` field",
            "; on workflow_advance the task parks in plan-review/ for the human gate",
          )
        : spawnNote("call workflow_stage, then spawn the subagent named in the `agent` field"),
  }
}

// --- server + tools ---

const server = new McpServer({ name: "agentic-workflow", version: "0.0.1" })

server.registerTool(
  "workflow_start",
  {
    description:
      "Execute one task now. An in-progress/ task (plan approved via workflow_plan_approve) is claimed and started at BUILD with git isolation; a queued/ task (approved via workflow_task_approve, planless) is claimed and started at PLAN — it will park in plan-review/ for the human plan gate. Returns the composed stage prompt. Entering PLAN arms the stage marker automatically (so the plan-author may write its own queued/ task); call workflow_stage right before spawning each later stage subagent.",
    inputSchema: { id: z.string().min(1).describe("The task's id (filename without .md) in in-progress/ or queued/.") },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${workflowId(active)}" — finish or workflow_stop it first.`)
    // Accept the short-hash handle (`f7k3`) the UIs surface as the copyable id —
    // the same resolution the gate tools do.
    const resolved = await resolveTaskIdAnywhere(sh, directory, config.tasksDir, id, log)
    if (resolved && "ambiguous" in resolved) {
      return fail(`Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`)
    }
    if (resolved) id = resolved.id
    const t = await findByIdIn(sh, directory, config.tasksDir, "in-progress", id)
    if (!t) {
      const queued = await findByIdIn(sh, directory, config.tasksDir, "queued", id)
      if (queued) {
        const started = await startPlan(queued)
        if ("error" in started) return fail(started.error)
        const warnings = await claimWarnings()
        return ok({ ...firePayload(started.state, id), ...(warnings.length ? { warnings } : {}) })
      }
      const elsewhere = await findAnyStatus(id)
      const where = elsewhere ? path.basename(path.dirname(elsewhere.path)) : null
      return fail(
        where === "plan-review"
          ? `Task "${id}" is parked in plan-review/ — approve its plan (workflow_plan_approve) or reject it (workflow_replan) first.`
          : where === "draft"
            ? `Task "${id}" is a draft — approve it into the queue with workflow_task_approve first.`
            : where
              ? `Task "${id}" is in ${where} — only queued or in-progress tasks can be executed.`
              : `No task "${id}" found.`,
      )
    }
    if (!isClaimable(t)) {
      return fail(
        isRecoverable(t)
          ? `Task "${id}" has already started — resume it with workflow_recover instead.`
          : `Task "${id}" has no Implementation Plan — send it back to planning with workflow_replan.`,
      )
    }
    const started = await startTask(t)
    if ("error" in started) return fail(started.error)
    const warnings = await claimWarnings()
    return ok({ ...firePayload(started.state, id), ...(warnings.length ? { warnings } : {}) })
  },
)

server.registerTool(
  "workflow_claim",
  {
    description:
      "Claim the next item and start it — the pull equivalent of the OpenCode plugin's /agentic-workflow:engineering watch. Polls all enabled workflow kinds in claim-priority order (engineering, then any opted-in kind — every sitter is opt-in via workflows.<kind>.enabled); pass `kind` to restrict the pull to one kind (e.g. /agentic-workflow:engineering claim pr-sitter). For engineering, build-ready in-progress/ work wins over planless queued/ work (finish what is in flight before planning more); within each pool, lowest priority number first. A queued claim enters at PLAN and parks the plan for your gate; workflow_start({id}) plans one now without waiting for a claim. Pass `target` (a PR number) with a PR-sitter `kind` to force that exact PR — it is claimed and driven even with no outstanding attention signal, overriding the poller's heuristic (the fork-PR refusal still holds). Returns null when nothing is claimable.",
    inputSchema: {
      kind: z.string().optional().describe("Restrict the pull to one enabled workflow kind (e.g. pr-sitter)."),
      target: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("A specific PR number to force-claim; requires a PR-shaped `kind` (pr-sitter / review-sitter)."),
    },
  },
  async ({ kind, target }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${workflowId(active)}" — finish or workflow_stop it first.`)
    if (kind && !enabledWorkflowKinds(config).includes(kind)) {
      return fail(`Unknown workflow kind "${kind}" — enabled: ${enabledWorkflowKinds(config).join(", ")}.`)
    }
    if (target != null) {
      if (!kind) return fail("target requires a `kind` — name the PR sitter (pr-sitter or review-sitter) that should claim PR #" + target + ".")
      if (manifestFor(kind).manifest.workSource.type !== "pull-request") {
        return fail(`Workflow kind "${kind}" is not a PR sitter — a specific PR target only applies to pr-sitter / review-sitter.`)
      }
    }
    const { claim, skips } = await pollOnce(sourcesFor(kind, target))
    if (!claim) {
      // Append the skip-set only when it changes — flood control for the event log.
      if (skips.length) {
        const key = skipSetKey(skips)
        if (lastSkipEventKey !== key) {
          lastSkipEventKey = key
          await emitSchedEvent({ type: "skip", reasons: [...skips] })
        }
      }
      return ok(skips.length ? { claimed: null, skips } : null)
    }
    lastSkipEventKey = null
    await emitSchedEvent({ type: "claim", kind: claim.item.workflowKind, id: claim.item.id })
    activeClaim = claim
    let state = claim.item.state
    resetLoopScratch()
    const loaded = manifestFor(claim.item.workflowKind)
    if (stageDef(loaded.manifest, state.stage).isolation !== "none") {
      try {
        // Task-backed claims get the durable CLAIMED note on the human branch
        // before feature/<id> is cut — same as startTask (see store.ts CLAIMED_MARKER).
        // Inside the try: a throw here must not strand activeClaim, or the NEXT
        // loop's terminal would fire onTerminal against this stale item.
        if (state.task) {
          await markClaimed(sh, state.task, await gitActor(sh, directory), log)
          // Unconditional for the reason `startTask`'s twin spells out above.
          await commitPaths(sh, directory, [config.tasksDir], `loop(${state.task.id}): claimed`)
        }
        state = await ensureIsolation(sh, log, directory, config, state, await resolveBase())
      } catch (err) {
        await claim.source.release(claim.item)
        await emitSchedEvent({ type: "release", kind: claim.item.workflowKind, id: claim.item.id })
        activeClaim = null
        return fail((err as Error).message)
      }
      active = state
      await snapshot()
    } else {
      active = state
      // Arm the stage marker for a no-isolation entry stage, mirroring startPlan
      // (workflow_start's queued path). Engineering's PLAN is spawned straight off this
      // claim with no workflow_stage call (firePayload emits no such instruction for
      // plan), so without the marker the {stage:"plan", taskId} carve-out never
      // exists and the plan-author's one write to queued/<id>.md is blocked (exit 2)
      // → workflow_advance finds no plan. Sitter check-stage entries re-arm via workflow_stage
      // anyway, so this is the fix for PLAN and a harmless no-op for them.
      const entryMarkerError = writeStageMarker(state.stage)
      if (entryMarkerError) {
        // PLAN is spawned straight off this claim with no workflow_stage call
        // (firePayload emits no such instruction for plan), so a failed arm
        // DOOMS the run rather than merely un-scoping it: the {stage:"plan",
        // taskId} carve-out never exists, the plan author's one legal write
        // (queued/<id>.md) is blocked by the always-on backlog guard, and the
        // stage burns a whole run to "the PLAN stage wrote no ## Implementation
        // Plan" — a misleading diagnosis for an unwritable runs/. Refuse
        // upfront and hand back everything the claim took, exactly as
        // `startPlan` does for the identical failure (the backlog source's
        // release() also restores a spent plan request).
        if (state.stage === "plan") {
          await claim.source.release(claim.item)
          await emitSchedEvent({ type: "release", kind: claim.item.workflowKind, id: claim.item.id })
          activeClaim = null
          active = null
          return fail(`Could not arm the PLAN stage marker — ${entryMarkerError}. Check that ${config.tasksDir}/runs/ is writable.`)
        }
        // A sitter's entry stage re-arms via workflow_stage, which reports the
        // same failure actionably before anything is spawned — a warn suffices.
        await log("warn", `could not arm the ${state.stage} stage marker — ${entryMarkerError}; the guard will not scope this stage`)
      }
    }
    const warnings = await claimWarnings()
    return ok({ ...firePayload(state, claim.item.id), ...(warnings.length ? { warnings } : {}) })
  },
)

server.registerTool(
  "workflow_compose",
  {
    description: "Return the composed prompt (goal + relevant prior artifacts + isolation lines) to hand a stage subagent.",
    inputSchema: { stage: z.string().min(1) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    try {
      // Composed for `stage`, so the state handed to core names `stage` too.
      // `promptContext` keys the check-results section on `state.stage` — which
      // the fire path always sets to its target first (`fireAt`) and this tool,
      // taking the stage as a free parameter, did not: previewing REVIEW while
      // the loop sat at VERIFY rendered VERIFY's check output into REVIEW's
      // prompt.
      return ok({ prompt: composePrompt(activeManifest(), { ...active, stage }, stage, config) })
    } catch (err) {
      return fail((err as Error).message)
    }
  },
)

server.registerTool(
  "workflow_verdict",
  {
    description:
      "Record the VERIFY or REVIEW verdict for the running loop. THE ONLY TRUSTED verdict channel — a PASS/FAIL in prose is ignored. Called by the workflow-verify/workflow-review subagent exactly once per pass. Multiple calls in one stage (multi-lens review) are combined worst-wins.",
    inputSchema: {
      stage: z.string().min(1).describe("The loop's currently running check stage (engineering: verify/review; pr-sitter: triage/verify)."),
      verdict: z.enum(["PASS", "FAIL", "ERROR"]),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          "One-sentence summary of why. REQUIRED on FAIL unless a criterion marked not met or a blocking finding " +
            "names the problem — a FAIL that names nothing to fix is REJECTED.",
        ),
      criteria: z
        .array(z.object({ criterion: z.string(), pass: z.boolean() }))
        .optional()
        .describe(
          "Per-acceptance-criterion results, mirroring the criteria threaded into your stage prompt. REQUIRED for a " +
            "PASS on a stage given acceptance criteria: one entry per criterion, in the order given — a PASS with " +
            "missing/incomplete criteria, or one marking any criterion not met, is REJECTED (record FAIL instead).",
        ),
      axes: z
        .array(
          z.object({
            axis: z.string().min(1).describe("The review axis this result covers (e.g. correctness, security)."),
            verdict: z
              .enum(["PASS", "FAIL", "ERROR"])
              .describe("ERROR only when this axis genuinely could not be assessed; an axis with no findings is a clean PASS."),
            findings: z
              .array(
                z.object({
                  severity: z.enum(["critical", "important", "suggestion"]),
                  detail: z.string().min(1),
                  location: z.string().optional().describe('"file:line" the finding is anchored to.'),
                }),
              )
              .optional(),
          }),
        )
        .optional()
        .describe(
          "Per-axis results. REQUIRED on a stage that declares requiredAxes (engineering review: all five axes) — a call missing an axis is REJECTED, and partial submissions are not accumulated across calls.",
        ),
      evidence: z
        .array(
          z.object({
            kind: z.enum(["command", "file"]).describe('"command" — something you ran; "file" — a path (or "path:line") you read.'),
            ref: z.string().min(1).describe("The command line as you issued it, or the path you read."),
            result: z.string().max(300).optional().describe("What you observed (e.g. \"42 passed, 0 failed\"). Audit trail only."),
          }),
        )
        .optional()
        .describe(
          "Proof of work. REQUIRED for a PASS on a stage that declares requireEvidence (engineering verify/review): this session's real commands and file reads are recorded independently, and a PASS citing nothing — or nothing matching what actually ran — is REJECTED. At least one citation must be work YOU did this pass: check commands the loop pre-ran are established fact, not your proof. FAIL/ERROR need none.",
        ),
    },
  },
  async ({ stage, verdict, reason, criteria, axes, evidence }) => {
    if (!active) return fail("No active loop — verdict ignored.")
    if (active.stage !== stage) {
      // The rejection alone reaches only the calling agent. Audit it on the task
      // so a work stage that ran a later stage's work inside its own turn is
      // visible in the trail, not just as odd behavior one stage later.
      if (!drifted) {
        drifted = { requested: stage, verdict }
        if (active.task) {
          await appendNote(sh, active.task, auditNote(stageDriftNote(active.stage, stage, verdict), new Date(), await gitActor(sh, directory)), log)
        }
      }
      return fail(stageDriftRefusal(active.stage, stage, { orchestrated: true }))
    }
    const def = activeManifest().manifest.stages.find((d) => d.name === stage)
    if (def?.kind !== "check") {
      return fail(`Stage ${stage} is not a check stage — verdict ignored.`)
    }
    const rec: VerdictRecord = {
      verdict,
      ...(reason ? { reason } : {}),
      ...(criteria ? { criteria: criteria as CriterionResult[] } : {}),
      ...(axes ? { axes: axes as AxisResult[] } : {}),
      ...(evidence ? { evidence: evidence as EvidenceItem[] } : {}),
    }
    // What the guard saw this attempt do, resolved per call rather than cached:
    // the ledger grows while the stage works, so a verdict recorded late in the
    // turn must read the ledger as it stands at that moment. `seeded` carries
    // the driver-run check commands separately from the ledger: they defeat the
    // "did nothing" rejection but cannot corroborate a PASS on their own.
    const evidenceCtx: EvidenceContext = {
      stage,
      required: def.requireEvidence,
      observed: observedEvidence(stage),
      seeded: checkCommands(active?.checks?.[stage] ?? []),
    }
    // Stage-level via the predicate, never `passAxes`: a lens pass owes no
    // axes, and the criteria gate must not suddenly bind lens passes of an
    // axis-bearing stage. Empty acceptance (sitter kinds carry no task) leaves
    // the gate inert.
    const criteriaCtx: CriteriaContext | undefined = stageRequiresCriteria(def)
      ? { stage, acceptance: active?.task?.acceptance ?? [] }
      : undefined
    // The record can only be obtained from the `ok: true` branch, so a rejected
    // verdict CANNOT reach `stampVerdictRecorded` below — which would otherwise
    // mark the stage satisfied for the SubagentStop guard and burn its one-shot
    // nag sentinel, letting the subagent stop having recorded nothing valid.
    // The axes THIS pass owes, not the stage's: a focused fan-out pass is
    // narrowed to its own axis (so it is admitted rather than rejected for the
    // ones it was told not to review), and a lens pass owes none at all — which
    // also fixes a lens pass on this host being rejected for missing four axes
    // it was never asked for. The stage-wide requirement is enforced on the
    // accumulated record in workflow_advance instead.
    const admission = admitVerdict(rec, passAxes(def, currentPass(stage)), pending, evidenceCtx, criteriaCtx)
    if (!admission.ok) {
      // Keep the refused record, not just the fact of a refusal: if the retry
      // below produces nothing admissible either, `rejectedFallback` routes the
      // stage on what it DECLARED rather than ERROR-stopping a check that
      // reported. Rejections MERGE worst-wins (`mergeRejected`) — keeping only
      // the last one let a rejected FAIL vanish behind a later rejected PASS,
      // and the run ERROR-stopped instead of rebuilding on the findings.
      verdictRejected = mergeRejected(verdictRejected, { record: rec, message: admission.message })
      return fail(admission.message)
    }
    pending = admission.record
    stampVerdictRecorded()
    // Report the DERIVED verdict: a declared PASS carrying a Critical finding on
    // any axis is a FAIL (verdict.ts `effectiveVerdict`).
    return ok({ recorded: effectiveVerdict(pending) })
  },
)

server.registerTool(
  "workflow_blocked",
  {
    description:
      "Report that the WORK stage now running cannot do its work at all — the approved plan is impossible or wrong as written, not merely hard. NOT a verdict on the work (a work stage may never record one) and NOT a way to skip a hard task: it stops the loop and sends the task back to a human for replanning. Call it instead of implementing something different from the approved plan.",
    inputSchema: {
      stage: z.string().min(1).describe("The loop's currently running work stage (engineering: build)."),
      reason: z.string().max(500).describe("One or two sentences on what makes the plan impossible, concrete enough for a human to replan from."),
    },
  },
  async ({ stage, reason }) => {
    if (!active) return fail("No active loop — blocked signal ignored.")
    if (active.stage !== stage) {
      return fail(`The loop is at ${active.stage}, not ${stage} — blocked signal ignored. Only the running stage may report itself blocked.`)
    }
    const def = activeManifest().manifest.stages.find((d) => d.name === stage)
    // The mirror of workflow_verdict's guard: that one rejects work stages, this
    // one rejects check stages, so neither channel can stand in for the other.
    if (def?.kind !== "work") {
      return fail(`Stage ${stage} is a check stage — report PASS/FAIL/ERROR with workflow_verdict instead.`)
    }
    blocked = { stage, reason }
    return ok({ recorded: "BLOCKED" })
  },
)

server.registerTool(
  "workflow_isolate",
  {
    description:
      "Explicitly ensure the feature/<id> branch (or worktree when worktreesDir is set) exists. Normally workflow_start does this; use it standalone only when recovering.",
    inputSchema: {},
  },
  async () => {
    if (!active) return fail("No active loop.")
    try {
      active = await ensureIsolation(sh, log, directory, config, active, await resolveBase())
    } catch (err) {
      return fail((err as Error).message)
    }
    await snapshot()
    return ok({ isolated: Boolean(active.isolated), git: active.git ?? null })
  },
)

server.registerTool(
  "workflow_stage",
  {
    description:
      "Set the current stage marker so the PreToolUse hook enforces the right bash allowlist (default-deny for verify/review) and the stage deadline. Call right before spawning EACH stage subagent, plan and build included. The stage must be the one the state machine is at (the stage the last fire action named) — a mismatch means workflow_advance was skipped and the call is rejected. Setting 'build' appends the audited 'BUILD started' note the claimability predicates key on. A stage that runs FOCUSED PASSES (the response's `passes` array, or the fire action's) needs one call per entry, each naming it in `focus`, and returns that pass's own `prompt`.",
    inputSchema: {
      stage: z.string().min(1),
      focus: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The single axis or lens THIS pass covers, on a stage that runs focused passes (they are listed in the `passes` array). " +
            "Omit on a single-pass stage. The response's `prompt` is this pass's prompt — hand it to the subagent instead of the fire payload's.",
        ),
    },
  },
  async ({ stage, focus }) => {
    if (!active) return fail("No active loop.")
    if (!activeManifest().manifest.stages.some((d) => d.name === stage)) {
      return fail(`Unknown stage "${stage}" for workflow kind "${activeManifest().manifest.kind}".`)
    }
    const outOfOrder = stageOrderError(active.stage, stage)
    if (outOfOrder) return fail(outOfOrder)
    const stageDefinition = stageDef(activeManifest().manifest, stage)
    const passes = passesFor(activeManifest().manifest.kind, stageDefinition)
    const labels = passLabels(activeManifest().manifest.kind, stageDefinition)
    if (focus && !labels.length) {
      return fail(`Stage ${stage} runs a single pass — call workflow_stage({stage:"${stage}"}) without a focus.`)
    }
    if (focus && !labels.some((l) => focusKey(l) === focusKey(focus))) {
      return fail(`Unknown focus "${focus}" for ${stage} — it runs one pass per: ${labels.join(", ")}.`)
    }
    // The enforcement that makes a fan-out actually fan out on this host: the
    // orchestrator owns the pass loop, so without this it could quietly collapse
    // N focused passes into one unfocused pass and lose the whole guarantee.
    if (!focus && labels.length) {
      return fail(
        `Stage ${stage} runs ${labels.length} focused passes, not one — call ` +
          `workflow_stage({stage:"${stage}", focus:"<one of ${labels.join(", ")}>"}) once per focus, spawn one subagent ` +
          `per call (sequentially — one pass is armed at a time), then call workflow_advance ONCE when all ${labels.length} have run.`,
      )
    }
    const index = focus ? passes.findIndex((p) => p.focus && focusKey(p.focus) === focusKey(focus)) : -1
    const pass: StagePass = index >= 0 ? passes[index]! : { focus: null, mode: "single" }
    // Arming the NEXT pass of a fan-out is also the moment the previous one
    // finished, and it is the only moment this server sees: `workflow_advance`
    // runs once for the whole stage. Sample here, before the size fields are
    // dropped below, or every pass but the last is invisible to the hub.
    if (armedPass?.stage === stage && armedPass.pass.focus) {
      samples.push({
        stage,
        iteration: active.iteration,
        ms: Date.now() - lastFireAt,
        startedAt: new Date(lastFireAt).toISOString(),
        lens: armedPass.pass.focus,
        ...promptSizeFields(),
      })
      flushRunMetrics(workflowId(active))
    }
    // The orchestrator is about to run a stage this server did not compose for —
    // drop the recorded size rather than attribute an older prompt to this pass.
    lastFirePromptChars = undefined
    lastFirePromptElided = undefined
    if (stageDef(activeManifest().manifest, stage).isolation !== "none") {
      // A no-isolation stage (engineering's PLAN) runs in the main tree — no branch, no worktree to reconcile.
      try {
        active = await ensureIsolation(sh, log, directory, config, active, await resolveBase()) // reconcile a moved/vanished worktree
      } catch (err) {
        return fail((err as Error).message)
      }
    }
    // A fresh arming of this stage, as opposed to the next pass of a fan-out
    // already under way — the same distinction the `pending` wipe below draws.
    const freshStage = fanoutStage !== stage || !pass.focus
    // Declared check commands run here: after isolation, before the stage is
    // armed, and once per fresh arming so the fan-out's passes share one result.
    if (freshStage) {
      try {
        active = await runStageChecks(active, stage)
      } catch (err) {
        return fail(`Could not run the check commands for "${stage}" — ${(err as Error).message}`)
      }
    }
    // Re-armed per pass, so every pass gets its own deadline and
    // verdictRecorded:false. The marker IS the guard's only input: if it could
    // not be written, the subagent about to be spawned would run either
    // unguarded or under the previous stage's allowlist — so refuse the stage
    // rather than report a success the enforcement layer cannot back.
    const markerError = writeStageMarker(stage)
    if (markerError) {
      return fail(
        `Could not arm the stage marker for "${stage}" — ${markerError}. ` +
          `That marker is what scopes the bash allowlist and the stage deadline, so the stage is not started. ` +
          `Check that ${config.tasksDir}/runs/ is writable, then retry.`,
      )
    }
    // Keep the claim stamp fresh at every stage boundary: `staleClaimMinutes`
    // covers one stage, but a whole loop can outlive it — without the refresh a
    // live run's marker reads as stale to another process's sweep/recover.
    // `refreshWorkClaim`, not `refreshClaimStamp`: a task-less sitter drive
    // restamps its own marker (state.claimMarkerDir) through the same seam.
    if (active) await refreshWorkClaim(sh, active)
    lastFireAt = Date.now()
    // Wiping `pending` is right for a FRESH stage and catastrophic mid-fan-out:
    // the orchestrator calls workflow_stage before every pass, so wiping here
    // would leave only the last pass's axis and the coverage gate would ERROR on
    // every run. Merging the passes is the point.
    if (freshStage) {
      pending = null // no stale verdict may leak into this stage
      // The kept rejection must SURVIVE the retry re-arm: the retry note tells
      // the orchestrator to call workflow_stage before re-spawning, so wiping
      // unconditionally here destroyed the very record `rejectedFallback`
      // routes on — a FAIL rejected twice then ERRORed blaming a "channel"
      // that answered both times. Only a genuinely new arming (no retry
      // pending) may clear it; stage transitions clear both in workflow_advance.
      if (!verdictRetried) verdictRejected = null
    }
    armedPass = pass.focus ? { stage, pass, index, total: passes.length } : null
    fanoutStage = pass.focus ? stage : null
    if (stage === "build" && active.task && buildNoteFor !== `${active.task.id}:${active.iteration}`) {
      // Same-stage re-fires are legal (stageOrderError allows them), but the
      // audited note must land once per build iteration, not once per call.
      buildNoteFor = `${active.task.id}:${active.iteration}`
      const actor = await gitActor(sh, directory)
      await appendNote(sh, active.task, auditNote(`BUILD started (iteration ${active.iteration + 1})`, new Date(), actor), log)
      // A degraded isolation (detached HEAD, checkout failure) must be visible
      // in the task's audit trail, not just a console warn — the run otherwise
      // looks identical to an isolated one while writing into the main tree.
      if (active.isolationWarning) {
        await appendNote(
          sh,
          active.task,
          auditNote(`WARNING: BUILD running WITHOUT isolation — ${active.isolationWarning}`, new Date(), actor),
          log,
        )
      }
    }
    const def = stageDefinition
    const model = stageModel(activeManifest().manifest.kind, def)
    const checked = (active.checks?.[stage]?.length ?? 0) > 0
    return ok({
      stage,
      agent: agentRef(def.agent),
      ...(model ? { model } : {}),
      worktree: active.git?.worktree ?? null,
      ...(active.isolationWarning ? { isolationWarning: active.isolationWarning } : {}),
      // The HONORED deadline (writeStageMarker applies def.timeoutMinutes ??
      // config), not the raw config — reporting the config while honoring the
      // override told the orchestrator the wrong number.
      deadlineMinutes: def.timeoutMinutes ?? config.stageTimeoutMinutes,
      // A focused pass gets its OWN prompt: the fire payload composed one prompt
      // for the stage, and each pass has to be told which axis it covers.
      ...(pass.focus
        ? {
            focus: pass.focus,
            passIndex: index + 1,
            prompt: firePrompt(activeManifest(), active, stage, `\n\n${passFocusBlock(pass, index, passes.length)}`),
          }
        : // A stage with checks gets a re-composed prompt for the same reason a
          // focused pass does: the fire payload was composed a turn earlier, so
          // it cannot carry results of commands that had not run yet.
          checked
          ? { prompt: firePrompt(activeManifest(), active, stage) }
          : {}),
      ...(labels.length ? { passes: labels } : {}),
      // The last thing the orchestrator reads before the Task call, and for many
      // stages the only spawn instruction it ever gets: the fire payload's note may
      // be several tool calls back, or authored away in the same turn when
      // workflow_stage and Task are emitted as two tool_use blocks at once.
      note: spawnNote(
        pass.focus
          ? `focused pass ${index + 1}/${passes.length} (${pass.focus}): spawn the subagent named in the \`agent\` field with THIS response's \`prompt\`` +
              (index + 1 < passes.length
                ? `, then call workflow_stage again with the next focus — do not call workflow_advance until all ${passes.length} have run`
                : ", then call workflow_advance once")
          : checked
            ? "spawn the subagent named in the `agent` field with THIS response's `prompt` — it carries the check commands the loop already ran"
            : "spawn the subagent named in the `agent` field",
        def.kind === "check" ? CHECK_VERDICT_TAIL : "",
      ),
    })
  },
)

server.registerTool(
  "workflow_advance",
  {
    description:
      "Feed a completed stage's output back into the state machine and get the next action. Returns {kind:'fire',stage,prompt} to run the next stage, or {kind:'done'|'stop'} (terminal — the task is moved and metrics written). Uses the verdict recorded via workflow_verdict for check stages. A stage past its stageTimeoutMinutes deadline stops the loop.",
    inputSchema: { stageOutput: z.string().describe("The finished stage subagent's summary/output text.") },
  },
  async ({ stageOutput }) => {
    if (!active) return fail("No active loop.")
    const stage = active.stage
    // Captured HERE, before `advance` moves `active.stage`: the advice names the
    // stage the loop was at when the verdict was refused, and it rides out on
    // every arm that hands the orchestrator its next action. Without it the only
    // trace of a skipped workflow_advance was a note in a file the driving model
    // never reads — so a REVIEW that ran and was thrown away looked, from the
    // orchestrator's seat, exactly like a REVIEW that had not run yet.
    const driftReport = drifted ? stageDriftAdvice(stage, drifted.requested, drifted.verdict) : null
    const withDrift = <T extends object>(payload: T): T & { drift?: string } =>
      driftReport ? { ...payload, drift: driftReport } : payload
    if (isOverdue(stageDeadline, Date.now())) {
      const action: Action = {
        kind: "stop",
        message: `✗ Loop stopped — ${stage} exceeded its stage timeout (${(stageDef(activeManifest().manifest, stage).timeoutMinutes ?? config.stageTimeoutMinutes).toString()}m). Fix what hung it, then /agentic-workflow:engineering recover the task.`,
      }
      samples.push({
        stage,
        iteration: active.iteration,
        ms: Date.now() - lastFireAt,
        startedAt: new Date(lastFireAt).toISOString(),
        // Same lens attribution as the ordinary arm below — the pass that hung
        // is precisely the one a metrics reader wants named.
        ...(armedPass?.stage === stage && armedPass.pass.focus ? { lens: armedPass.pass.focus } : {}),
        ...promptSizeFields(),
      })
      await runTerminal(action)
      // Every arm that returns to the orchestrator carries the drift, this one
      // included — a stage that hung AND had a verdict refused is exactly the run
      // whose "it timed out" must not be the only thing reported.
      return ok(withDrift({ action }))
    }
    // record a metrics sample for the stage that just finished — startedAt
    // anchors the time window transcript-based token joins attribute against
    samples.push({
      stage,
      iteration: active.iteration,
      ms: Date.now() - lastFireAt,
      startedAt: new Date(lastFireAt).toISOString(),
      // Under fan-out this is the LAST pass's row (the earlier ones were sampled
      // as they were superseded in workflow_stage), and it is the row that
      // carries the stage's verdict — so a fan-out contributes one sample per
      // pass and exactly one verdict row, as a single-pass stage does.
      ...(armedPass?.stage === stage && armedPass.pass.focus ? { lens: armedPass.pass.focus } : {}),
      ...promptSizeFields(),
      ...(stageDef(activeManifest().manifest, stage).kind === "check"
        ? {
            verdict: (pending ? effectiveVerdict(pending) : "none") as Verdict | "none",
            // Structured verdict mirror (redacted) — the cross-run "top recurring
            // findings" join key; the prose stays in the run log.
            ...verdictStructure(pending),
            // Check-command provenance — on the stage's verdict row only, so a
            // roll-up sums refusals once per stage firing.
            ...(() => {
              const info = checksInfo.get(stage)
              return info ? { checksSource: info.source, ...(info.refused ? { checksRefused: info.refused } : {}) } : {}
            })(),
          }
        : {}),
    })
    flushRunMetrics(workflowId(active)) // publish samples-so-far live to the hub
    // A check stage that ended with NO workflow_verdict call is a broken verdict
    // channel, not a genuine FAIL — re-fire the same check once (no iteration
    // consumed, no rebuild), then stop with a retryable ERROR instead of
    // burning build iterations on a stage that may have passed (the
    // theater-booking-0 failure mode: three rebuilds of an already-done task).
    // Whether `pending` below is a record salvaged from a rejected declaration
    // (a FAIL routed as declared) — the coverage gate must not convert it back
    // to ERROR.
    let salvagedFail = false
    if (stageDef(activeManifest().manifest, stage).kind === "check" && !pending) {
      // Diagnostic only — free text never flips control flow (verdict.ts).
      const prose = parseVerdict(stageOutput, `WORKFLOW_${stage.toUpperCase()}`)
      if (!verdictRetried) {
        // The marker write must succeed BEFORE the retry is marked consumed —
        // a failing write here used to still set `verdictRetried = true`, so a
        // transient infra hiccup burned the one retry the model never actually
        // got: the next call skipped straight to the "retry is spent" fallback
        // below, turning a hiccup into an immediate stage failure. Leaving the
        // flag false on failure lets a follow-up call re-enter this same arm.
        const refireMarkerError = writeStageMarker(stage) // fresh deadline + verdictRecorded:false for the re-fire
        if (refireMarkerError)
          return fail(`Could not re-arm the stage marker for "${stage}" — ${refireMarkerError}. The stage is not re-fired — call workflow_stage again to retry.`)
        verdictRetried = true
        if (active.task) {
          const noteActor = await gitActor(sh, directory)
          await appendNote(
            sh,
            active.task,
            auditNote(
              verdictRejected
                ? `${stage.toUpperCase()} offered a verdict that was rejected and never recorded — re-running the check once (${verdictRejected.message})`
                : `${stage.toUpperCase()} ended with no workflow_verdict call — re-running the check once (prose claimed ${prose ?? "nothing"}; free text is untrusted)`,
              new Date(),
              noteActor,
            ),
            log,
          )
        }
        lastFireAt = Date.now()
        armedPass = null // its sample is already recorded; the retry arms its own — same rule as the gap-passes retry below
        const retryModel = stageModel(activeManifest().manifest.kind, stageDef(activeManifest().manifest, stage))
        // On a stage that runs focused passes, a bare "call workflow_stage"
        // retry is a dead end — workflow_stage refuses an unfocused call on a
        // labeled stage. Name the passes, exactly as the axis-gap retry does.
        const retryLabels = passesFor(activeManifest().manifest.kind, stageDef(activeManifest().manifest, stage))
          .map((p) => p.focus)
          .filter((f): f is string => f !== null)
        return ok(withDrift({
          action: { kind: "fire", stage },
          agent: agentRef(stageDef(activeManifest().manifest, stage).agent),
          ...(retryModel ? { model: retryModel } : {}),
          ...(retryLabels.length ? { passes: retryLabels } : {}),
          prompt: firePrompt(
            activeManifest(),
            active,
            stage,
            (verdictRejected
              ? "\n\nPREVIOUS ATTEMPT'S VERDICT WAS REJECTED and never recorded — it did not cover every required axis, " +
                "it declared FAIL without naming a critical/important finding, or it declared PASS without citing " +
                "evidence this session actually ran. The rejection said: " +
                verdictRejected.message +
                "\nCall workflow_verdict ONCE with the COMPLETE axes array (partial " +
                "submissions are not accumulated) and, for a PASS, an `evidence` array naming the commands you ran and " +
                "the files you read THIS pass — re-run them if you have not."
              : "\n\nPREVIOUS ATTEMPT RECORDED NO VERDICT — the workflow_verdict tool call is MANDATORY. " +
                "If the tool is not in your tool list, state that explicitly in your final message and finish."),
          ),
          note: spawnNote(
            (verdictRejected
              ? "check retry (no iteration consumed): the previous pass's verdict was rejected and never recorded — "
              : "check retry (no iteration consumed): the previous pass never called workflow_verdict — ") +
              (retryLabels.length
                ? `call workflow_stage({stage:"${stage}", focus:"<pass>"}) and spawn the stage subagent again for EACH pass in \`passes\``
                : "call workflow_stage, then spawn the stage subagent again"),
            CHECK_VERDICT_TAIL,
          ),
        }))
      }
      // The retry is spent. A stage that DID report — twice, refused twice — is
      // routed on what it declared: a rejected FAIL becomes the stage's FAIL, so
      // `onFail` re-fires BUILD with the findings instead of `onError` ending the
      // run. Only a never-recorded (or unearned-PASS) stage still ERRORs, and it
      // no longer blames plugin wiring that demonstrably worked.
      const salvaged = rejectedFallback(verdictRejected)
      salvagedFail = salvaged !== null && effectiveVerdict(salvaged) === "FAIL"
      if (salvaged && active.task) {
        await appendNote(
          sh,
          active.task,
          auditNote(
            `${stage.toUpperCase()} verdict rejected twice — recorded as declared (${effectiveVerdict(salvaged)}) so the loop acts on it`,
            new Date(),
            await gitActor(sh, directory),
          ),
          log,
        )
      }
      pending = salvaged ?? {
        verdict: "ERROR",
        reason: noAdmissibleVerdictReason({ rejected: verdictRejected, prose }),
      }
    }
    // The completeness gate. Per-pass admission proves each pass covered ITS
    // axis; it can never prove every axis ran, because on THIS host the
    // orchestrator owns the pass loop and can simply skip a spawn. Only the
    // accumulated record shows that — so check it here, re-fire just the missing
    // passes once (no iteration consumed), then stop with ERROR rather than
    // re-build on a review that never happened.
    const gateDef = stageDef(activeManifest().manifest, stage)
    const gatePasses = passesFor(activeManifest().manifest.kind, gateDef)
    if (gateDef.kind === "check" && pending && enforcesAxisCoverage(config, activeManifest().manifest.kind, gateDef)) {
      const gaps = uncoveredAxes(pending, gateDef.requiredAxes)
      // The retry below re-fires one pass per missing axis, so it needs a pass
      // `workflow_stage({focus})` can resolve the axis name to: every axis pass
      // by construction, and a lens set that names the axes verbatim — the only
      // lens shape `enforcesAxisCoverage` turns this gate on for — where the
      // axis name IS a lens name. Only a gap naming no pass (a partial lens
      // overlap) still goes straight to ERROR: there is no targeted pass to
      // re-run, and re-firing every lens would re-review what already reported.
      // Through `focusKey`, matching every other focus/axis comparison
      // (`enforcesAxisCoverage` → `unreviewedAxes` normalizes, and
      // workflow_stage resolves `focus` case-insensitively): an exact-string
      // test here silently skipped the targeted retry for a lens list that
      // spells the axes with different casing — the coverage gate was on, the
      // retry would have worked, and the stage went straight to the ERROR stop.
      const passFoci = new Set(gatePasses.map((p) => (p.focus === null ? null : focusKey(p.focus))).filter((f): f is string => f !== null))
      const retryableByFocus = gatePasses.some((p) => p.mode === "axis") || (gaps.length > 0 && gaps.every((g) => passFoci.has(focusKey(g))))
      if (gaps.length && retryableByFocus && !verdictRetried) {
        // Same rule as every other arm: a re-run the guard cannot scope must not
        // be handed out as if it were scoped. And the marker write must succeed
        // BEFORE the retry is marked consumed — a failing write here used to
        // still set `verdictRetried = true`, burning the one retry the model
        // never actually got.
        const gapMarkerError = writeStageMarker(stage)
        if (gapMarkerError)
          return fail(`Could not re-arm the stage marker for "${stage}" — ${gapMarkerError}. The gap passes are not re-run — call workflow_stage again to retry.`)
        verdictRetried = true
        if (active.task) {
          await appendNote(
            sh,
            active.task,
            auditNote(
              `${stage.toUpperCase()} fan-out recorded no result for ${gaps.join(", ")} — re-running those passes once`,
              new Date(),
              await gitActor(sh, directory),
            ),
            log,
          )
        }
        lastFireAt = Date.now()
        armedPass = null // its sample is already recorded; the retry arms its own
        const gapModel = stageModel(activeManifest().manifest.kind, gateDef)
        return ok(withDrift({
          action: { kind: "fire", stage },
          agent: agentRef(gateDef.agent),
          ...(gapModel ? { model: gapModel } : {}),
          passes: gaps,
          note: spawnNote(
            `axis retry (no iteration consumed): ${gaps.join(", ")} recorded no verdict — call ` +
              `workflow_stage({stage:"${stage}", focus:"<axis>"}) and spawn the stage subagent again for EACH of them`,
            CHECK_VERDICT_TAIL,
          ),
        }))
      }
      if (gaps.length) {
        // A salvaged FAIL stays FAIL — a rejected verdict is not a missing one.
        // Converting it back to ERROR here would undo the salvage the spent
        // retry just bought: `review.onError` would stop the run instead of
        // `onFail` feeding BUILD the findings. The gap rides the reason so the
        // rebuild knows coverage was partial.
        pending = salvagedFail
          ? { ...pending, reason: [pending.reason, `(coverage gap: no verdict recorded for ${gaps.join(", ")})`].filter(Boolean).join(" ") }
          : withCoverageGap(pending, gaps)
      }
    }
    // Floor the admitted record with the checks this host ran for the stage,
    // then refuse a declared PASS whose every axis was unassessed. HERE, at
    // finalization, and never inside `admitVerdict`: a pre-seeded check
    // axis would flow through `blockingFindingsIssue` and get a genuine agent
    // PASS rejected rather than derived down. Identity when every check passed
    // and something was assessed, so a green run records exactly what the agent recorded.
    pending = finalizeCheckRecord(pending, active.checks?.[stage] ?? [])
    // `advance` threads the structured feedback (reason, failed criteria, failing
    // axes) ahead of the prose for the next iteration and records the seam, so a
    // stage context budget can clamp the prose without touching the block. The
    // fused artifact is byte-identical to what this site used to build by hand.
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      // Lockfiles excluded (CHECKPOINT_LOCKFILE_EXCLUDES): VERIFY's npm install
      // churn must not ride the checkpoint into REVIEW's diff boundary.
      // In current-branch mode the tree is shared: after this run's lock went
      // stale and a rival re-took it, `git add -A` here would commit the rival's
      // in-flight work as this run's checkpoint. Free outside that mode — the
      // predicate short-circuits unless the state is on the current branch.
      if (await rivalHoldsCurrentBranchLock(sh, directory, config, active)) {
        await log("warn", "loop: this tree's current-branch lock is held by another run now — skipping the build checkpoint")
      } else {
        await commitAll(
          sh,
          workTree(),
          `loop(${workflowId(active)}): build checkpoint (iteration ${active.iteration + 1})`,
          active.git?.worktree ? [config.tasksDir, ...CHECKPOINT_LOCKFILE_EXCLUDES] : [...CHECKPOINT_LOCKFILE_EXCLUDES],
        )
      }
    }
    if (stageDef(activeManifest().manifest, stage).kind === "check" && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      const failedAxes = (pending?.axes ?? []).filter((a) => !axisUnassessed(a) && axisVerdict(a) !== "PASS").map((a) => a.axis)
      const unassessed = (pending?.axes ?? []).filter(axisUnassessed).map((a) => a.axis)
      const detail = [
        failed ? `${failed} criteria unmet` : "",
        failedAxes.length ? `axes: ${failedAxes.join(", ")}` : "",
        unassessed.length ? `unassessed: ${unassessed.join(", ")}` : "",
      ].filter(Boolean).join("; ")
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending ? effectiveVerdict(pending) : "none → FAIL"}${detail ? ` (${detail})` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    // A work stage that called `workflow_blocked`: hand `advance` an ERROR so it
    // takes the manifest's `onError` arm (engineering build → stop, "replan")
    // instead of firing the next stage regardless. Kinds whose work stages declare
    // no such arm fall back to `onDone` inside the engine, so this is inert there.
    const blockedHere = blocked?.stage === stage ? blocked : null
    if (blockedHere && active.task) {
      // The loop is about to stop and ask a human to replan; the reason has to be
      // readable in the task file, not only in this session's transcript.
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} blocked — ${blockedHere.reason} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    // The derived verdict, not the declared one — an agent must not be able to
    // report PASS while flagging a Critical finding on an axis.
    const verdict = stageDef(activeManifest().manifest, stage).kind === "check" ? (pending ? effectiveVerdict(pending) : null) : blockedHere ? "ERROR" : null
    const record = blockedHere ? { verdict: "ERROR" as const, reason: blockedHere.reason } : pending
    const { state, action } = advance(activeManifest(), active, config, stageOutput, verdict, record)
    active = state
    pending = null
    blocked = null // consumed — no blocked signal may survive its own transition
    verdictRetried = false // the transition happened — the next check stage gets its own retry budget
    verdictRejected = null
    armedPass = null // no pass of the finished stage may admit a verdict for the next one
    fanoutStage = null
    drifted = null // reported above via `driftReport`; the next stage attempt starts clean

    if (action.kind === "fire") {
      await snapshot()
      const nextDef = stageDef(activeManifest().manifest, action.stage)
      const nextModel = stageModel(activeManifest().manifest.kind, nextDef)
      const nextPasses = passLabels(activeManifest().manifest.kind, nextDef)
      return ok(withDrift({
        action: { kind: "fire", stage: action.stage },
        agent: agentRef(nextDef.agent),
        ...(nextModel ? { model: nextModel } : {}),
        prompt: firePrompt(activeManifest(), active, action.stage),
        ...(nextPasses.length ? { passes: nextPasses } : {}),
        note: spawnNote(
          nextPasses.length
            ? `call workflow_stage once per entry in \`passes\` (focus: ${nextPasses.join(", ")}), spawning the subagent named in the \`agent\` field for each`
            : "call workflow_stage, then spawn the subagent named in the `agent` field",
          nextDef.kind === "check" ? CHECK_VERDICT_TAIL : "",
        ),
      }))
    }
    if (action.kind === "park") {
      // PLAN finished — validate the plan landed on the task file, then park
      // it in plan-review/ for the human gate and end the loop. No snapshot:
      // PLAN never resumes from one.
      const result = await runPark(action)
      return "error" in result ? fail(result.error) : ok(withDrift(result))
    }
    // terminal: done / stop
    const taskId = active.task?.id ?? null // runTerminal nulls `active`
    await snapshot()
    const report = await runTerminal(action)
    // A done whose park failed (core reports stop: the move to in-review/ was
    // blocked) must not announce the ship gate — the task is still in
    // in-progress/. Surface core's failure message instead.
    const parked = action.kind !== "done" || report?.kind === "done"
    // Carried onto the terminal arm too: a run that ended having silently thrown
    // away a stage's verdict is exactly the run whose result must not be read as
    // clean, and this is the last thing the orchestrator sees.
    return ok(withDrift({
      action: parked
        ? { kind: action.kind, message: (action as { message: string }).message }
        : { kind: "stop", message: report?.message ?? (action as { message: string }).message },
      ...(action.kind === "done" && parked && taskId
        ? (() => {
            const done = report?.kind === "done" ? report : null
            // The diff summary used to be a model-run errand ("show the user the
            // loop branch's diff summary"); with core computing the stat at
            // runDone, the prose leads with the deterministic numbers and the
            // exact command instead of asking the model to derive the range.
            const diffLine = done?.diffstat
              ? `the run's diff is ${done.diffstat}${done.diffCmd ? ` (\`${done.diffCmd}\`)` : ""} — show the user that summary`
              : `show the user the loop branch's diff summary`
            const suggLine = done?.suggestions?.length
              ? ` Relay the reviewer's ${done.suggestions.length} non-blocking suggestion${done.suggestions.length === 1 ? "" : "s"} too (this result's \`suggestions\`; also on the task's audit note) — they inform the diff review, they block nothing.`
              : ""
            return {
              taskId,
              gate: { kind: "ship", id: taskId },
              ...(done?.diffstat ? { diffstat: done.diffstat } : {}),
              ...(done?.diffCmd ? { diffCmd: done.diffCmd } : {}),
              ...(done?.suggestions?.length ? { suggestions: done.suggestions } : {}),
              next:
                `ship gate: ${diffLine}, then ask with ${dialect.askTool} — ` +
                `Ship (workflow_ship("${taskId}")), Replan with a reason (workflow_replan("${taskId}", reason)), ` +
                `or Leave in in-review (stop here; /agentic-workflow:engineering approve ${taskId} ships it later). ` +
                // The publish choice belongs to THIS ask and no later one: the ship
                // gate blocks its own turn, so once the task is completed there is
                // no turn left to ask in.
                `If they choose Ship, offer the publish choice too — open a draft PR, push the branch only, or keep it local — ` +
                `and pass it as workflow_ship's publish argument ("pr" | "push" | "local"). Omit publish if they have no preference.` +
                suggLine,
            }
          })()
        : {}),
    }))
  },
)

/**
 * Terminal bookkeeping for the PLAN stage's park — a thin adapter over core's
 * shared `runTerminal` (validate, plan-landed check, move, commit, metrics). This
 * host owns only the presentation: null the in-memory loop, fire the work source's
 * `onTerminal`, clear the stage marker, and serialize the plan-gate descriptor.
 */
const runPark = async (
  action: Extract<Action, { kind: "park" }>,
): Promise<
  | { error: string }
  | { action: { kind: "park"; message: string }; path: string; gate?: { kind: "plan"; id: string }; next: string }
> => {
  if (!active) {
    activeClaim = null
    active = null
    resetLoopScratch() // a loop that ends leaves no pass armed for the next one
    writeStageMarker(null)
    return { error: "No task-backed loop to park." }
  }
  const actor = await gitActor(sh, directory)
  const task = active.task
  let report: TerminalReport
  try {
    report = await coreRunTerminal(terminalCtx(active, actor), action)
  } catch (err) {
    // A dangling `validateBeforeTransition` ref (an unregistered hook for a
    // custom/user-added kind) throws as core's `runPark` FIRST statement,
    // before any `releaseClaim` runs. OpenCode is saved by `onIdle`'s
    // catch-all (unconditional claim release on any thrown drive error); this
    // host has no equivalent, so without this the queued/ claim marker is
    // held until the ~75-minute stale sweep. Best-effort: releasing must not
    // itself throw and mask the original error.
    if (task) {
      try {
        await releaseClaim(sh, task, log)
      } catch {
        // already best-effort; nothing more to do
      }
    }
    activeClaim = null
    active = null
    resetLoopScratch()
    writeStageMarker(null)
    return { error: `Park failed for "${task?.id ?? "the active loop"}" — ${(err as Error).message}. Its claim has been released.` }
  }
  // A task-less park and a veto/plan-not-landed both leave nothing to review (a park
  // action never yields done/stop, but narrowing keeps the descriptor's types honest).
  if (report.kind !== "park") {
    activeClaim = null // core already released any queued claim
    active = null
    resetLoopScratch()
    writeStageMarker(null)
    return { error: report.kind === "park-free" ? "No task-backed loop to park." : report.message }
  }
  // report.kind === "park": the plan landed and parked in plan-review/.
  const id = report.taskId
  if (activeClaim) {
    await activeClaim.source.onTerminal?.(activeClaim.item, { kind: "park", message: action.message })
    await emitSchedEvent({ type: "terminal", kind: activeClaim.item.workflowKind, id: activeClaim.item.id, outcome: "park" })
    activeClaim = null
  }
  active = null
  resetLoopScratch()
  writeStageMarker(null)
  // Auto-plan: the task opted in at its task gate (`approve <id> --auto-plan`),
  // so the plan gate is crossed here — deterministically, by the server, never
  // as an instruction the orchestrator might skip. The flag is judged on the
  // freshly parked FILE (a replan or fresh approve may have cleared it), and
  // the descriptor then omits `gate` on purpose: the plan-gate ask hook and the
  // orchestrator's own gate prose key off it, and both would otherwise put a
  // question for a gate that no longer exists. A failed approve degrades to the
  // ordinary parked descriptor plus the failure, which the human gate handles.
  const parkedTask = await findByIdIn(sh, directory, config.tasksDir, "plan-review", id)
  if (parkedTask?.autoPlan === true) {
    // --auto-plan means "skip the question when there is nothing to ask". The
    // manual gate shows these caveats at the exact moment the approval is
    // still the human's to withhold; crossing past them automatically would
    // mean the one plan defect whose cost is paid an iteration later (no
    // ### Verification subsection — so no discovered checks will run) is seen
    // by NO ONE. Fail toward human review — same shape as the failed-approve
    // degrade below: the plan stays parked, the flag stays on the file, and a
    // manual approve still crosses anyway.
    const caveats = planCaveats(parkedTask)
    if (caveats.length > 0) {
      return {
        action: { kind: "park", message: action.message },
        path: report.path,
        gate: { kind: "plan", id },
        next:
          `auto-plan declined to cross the plan gate: ${caveats.join("; ")}. ` +
          `Fall back to the human gate: show the user the plan summary and these caveats, then ask with ${dialect.askTool} — ` +
          `Approve anyway (workflow_plan_approve("${id}") then workflow_start("${id}")), Replan with a reason (workflow_replan("${id}", reason)), or Park for later.`,
      }
    }
    const gateResult = await approvePlan(id)
    if (gateResult.ok) {
      return {
        action: { kind: "park", message: `${action.message} Auto-plan: the plan gate was crossed automatically — "${id}" is build-ready in in-progress/.` },
        path: report.path,
        next: `auto-plan: the plan was approved automatically (--auto-plan) — call workflow_start({id: "${id}"}) to begin BUILD now, or stop here and the next claim builds it. Do not ask the plan-gate question; that gate is already crossed.`,
      }
    }
    return {
      action: { kind: "park", message: action.message },
      path: report.path,
      gate: { kind: "plan", id },
      next:
        `auto-plan could not approve the parked plan (${gateResult.message}) — fall back to the human gate: ` +
        `show the user the plan summary, then ask with ${dialect.askTool} — ` +
        `Approve (workflow_plan_approve("${id}") then workflow_start("${id}")), Replan with a reason (workflow_replan("${id}", reason)), or Park for later.`,
    }
  }
  return {
    action: { kind: "park", message: action.message },
    path: report.path,
    gate: { kind: "plan", id },
    next:
      `plan gate: show the user the plan summary, then ask with ${dialect.askTool} — ` +
      `Approve (workflow_plan_approve("${id}") then workflow_start("${id}") continues into BUILD now), ` +
      `Replan with a reason (workflow_replan("${id}", reason)), ` +
      `or Park for later (stop here; /agentic-workflow:engineering approve ${id} resumes it).`,
  }
}

server.registerTool(
  "workflow_stop",
  {
    description: "Abort the active loop: checkpoint partial work, append an audited stop note, write the run summary, clear the snapshot, and tear down isolation. The loop branch keeps the committed work.",
    inputSchema: {},
  },
  async () => {
    if (!active) return ok({ stopped: false, note: "no active loop" })
    const action: Action = {
      kind: "stop",
      message: `Loop stopped by /agentic-workflow:engineering stop at ${active.stage} (iteration ${active.iteration + 1}).`,
    }
    await runTerminal(action)
    return ok({ stopped: true })
  },
)

/**
 * Terminal bookkeeping for done/stop — a thin adapter over core's shared
 * `runTerminal` (audit note, task move, backlog commit, metrics, and the
 * `isolated`-gated checkpoint + teardown that keeps a never-isolated stage off
 * the human's main tree). This host owns only the presentation: clear the stage
 * marker, fire the work source's `onTerminal`, and null the in-memory loop.
 */
const runTerminal = async (action: Action): Promise<TerminalReport | null> => {
  if (!active || (action.kind !== "done" && action.kind !== "stop")) return null
  const actor = await gitActor(sh, directory)
  const task = active.task
  const claim = activeClaim
  let report: TerminalReport
  try {
    report = await coreRunTerminal(terminalCtx(active, actor), action)
  } catch (err) {
    // The same guard `runPark` carries, on the path that needs it MORE: this one
    // runs `closeIsolation` — a checkpoint commit and a worktree teardown —
    // where the park path only runs a validate hook. Without it a throw skips
    // every line below, and each omission wedges something: the stage marker
    // stays armed (the PreToolUse guard keeps enforcing a dead stage, and the
    // task reads as driven to every gate), the source's claim marker is never
    // released, `active`/`activeClaim` stay set so the next claim refuses, and
    // the fan-out scratch stays armed for the following loop. OpenCode's driver
    // has had this catch all along.
    try {
      if (task) await releaseClaim(sh, task, log)
      // A task-less (sitter) drive holds its claim through the work source, so
      // releasing the task ref alone would leave that marker held.
      if (claim) await claim.source.release?.(claim.item)
    } catch {
      // already best-effort; the original failure is what the caller must see
    }
    activeClaim = null
    active = null
    resetLoopScratch()
    writeStageMarker(null)
    throw err
  }
  writeStageMarker(null)
  if (activeClaim) {
    const detail = report.kind === "done" ? "review passed" : report.message
    const outcome = {
      kind: report.kind === "done" ? ("done" as const) : ("stop" as const),
      message: detail,
      // A retryable stop (transient onError) must not be recorded as a failed attempt (C2).
      ...(report.kind === "stop" && report.retryable ? { retryable: true } : {}),
    }
    await activeClaim.source.onTerminal?.(activeClaim.item, outcome)
    await emitSchedEvent({
      type: "terminal",
      kind: activeClaim.item.workflowKind,
      id: activeClaim.item.id,
      outcome: outcome.kind,
      ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
    })
    activeClaim = null
  }
  active = null
  resetLoopScratch() // a loop stopped mid-fan-out must not leave fanoutStage armed for the next loop
  return report
}

server.registerTool(
  "workflow_checkpoint",
  { description: "Commit the current build state as a checkpoint on the loop branch/worktree.", inputSchema: { message: z.string() } },
  async ({ message }) => {
    if (!active?.git) return ok({ committed: false, note: "no isolation active" })
    // Same shared-tree rule as the build checkpoint: never `git add -A` a tree
    // whose current-branch lock a rival run holds now.
    if (await rivalHoldsCurrentBranchLock(sh, directory, config, active)) {
      return ok({ committed: false, note: "the current-branch lock is held by another run — checkpoint skipped" })
    }
    const done = await commitAll(sh, workTree(), message, active.git.worktree ? [config.tasksDir, ...CHECKPOINT_LOCKFILE_EXCLUDES] : [...CHECKPOINT_LOCKFILE_EXCLUDES])
    return ok({ committed: done })
  },
)

server.registerTool(
  "workflow_note",
  { description: "Append a timestamped, secret-redacted audit note to the active loop's task file.", inputSchema: { text: z.string() } },
  async ({ text }) => {
    if (!active?.task) return fail("No active task-backed loop.")
    await appendNote(sh, active.task, auditNote(text, new Date(), await gitActor(sh, directory)), log)
    return ok({ noted: true })
  },
)

/** The workflow kinds this repo ships (workflows/<kind>/ dirs) with their enabled state. */
const kindsReport = (): { kind: string; enabled: boolean }[] => {
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
  return known.map((kind) => ({ kind, enabled: enabled.includes(kind) }))
}

server.registerTool(
  "workflow_status",
  {
    description:
      "Report the active loop (stage/iteration) plus a whole-backlog roll-up: counts per folder, the actionable flags, and the workflow kinds (enabled/disabled).",
    inputSchema: {},
  },
  async () => {
    await loadCfg()
    const byStatus = {} as Record<TaskStatus, Task[]>
    for (const s of STATUSES) byStatus[s] = await listByStatus(fsClient, directory, config.tasksDir, s, log)
    // The claim markers are what split body-claimable tasks into claimable vs
    // claim-held; without them every held task misreports as "ready" here (the
    // OpenCode host has always passed them — this one silently didn't).
    const summary = summarizeBacklog(byStatus, await listClaimIds(sh, directory, config.tasksDir))
    const hints = nextActions(summary, "/agentic-workflow:engineering")
    const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
    const pm = config.projectManagement
    return ok({
      active: active ? { stage: active.stage, iteration: active.iteration + 1, task: active.task?.id ?? active.goal } : null,
      backlog: summary,
      kinds: kindsReport(),
      ...(hints.length ? { nextActions: hints } : {}),
      ...(pm ? { pairing: { system: pm.system, ...pairingCoverage(byStatus) } } : {}),
      ...(hasAnomalies(anomalies) ? { anomalies: formatAnomalies(anomalies, config.tasksDir).map((l) => `${l} (workflow_doctor repairs)`) } : {}),
    })
  },
)

server.registerTool(
  "workflow_init",
  {
    description:
      "/agentic-workflow:engineering init — scaffold this repo for the backlog loop: create the tasksDir status folders, write a safe-key .agentic-workflow.json when none exists (NEVER overwrites an existing one), and git-exclude the backlog when ignoreBacklog is on. Idempotent — re-running reports what already existed and changes nothing.",
    inputSchema: {},
  },
  async () => {
    await loadCfg()
    const r = await initRepo(sh, directory, config, log)
    return ok(r)
  },
)

server.registerTool(
  "workflow_doctor",
  {
    description:
      "Audit the backlog for structural damage a confused agent can cause: stray folders (not a status folder), task files outside every status folder, duplicate ids across status folders, and held claim markers — plus the allowlist deny log (bash commands the check stages refused, aggregated with the config change that would admit each). With fix:true, performs only the unambiguous repairs — rescue stray .md files back to draft/ (audited note + commit), remove now-empty stray folders, release stale orphaned claim markers, and clear the reported deny log. Duplicates are always flagged for a human, never auto-resolved.",
    inputSchema: {
      fix: z.boolean().optional().describe("Apply the unambiguous repairs instead of only reporting."),
      config: z
        .boolean()
        .optional()
        .describe(
          "Return the effective-config report instead of the backlog audit: the layer file paths, which repo-layer keys the runtime ignores (user-layer-only), and the config actually in force with secrets masked.",
        ),
    },
  },
  async ({ fix, config: wantConfig }) => {
    await loadCfg()
    // A different question than the audit — "what configuration is actually in
    // force, and why isn't my repo key taking effect" — answered from the same
    // seam the load-time drops and the hub's effective view read.
    if (wantConfig) {
      const cfgReport = effectiveConfigReport(directory, config)
      return ok({
        configReport: cfgReport,
        ...(cfgReport.droppedRepoKeys.length
          ? {
              note:
                `${cfgReport.droppedRepoKeys.length} repo-layer key(s) are ignored at runtime (honored from the user-scope config only): ` +
                `${cfgReport.droppedRepoKeys.join(", ")} — move them to the user config to take effect.`,
            }
          : {}),
      })
    }
    const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
    const heldClaims: Record<string, string[]> = {}
    for (const status of ["queued", "in-progress"] as const) {
      const ids = await listClaimIds(sh, directory, config.tasksDir, status)
      if (ids.length) heldClaims[status] = ids
    }
    // A plan request whose task has left queued/ reorders nothing and blocks
    // nothing, but it lingers — name it rather than leave an unexplained marker.
    const queuedNow = await listByStatus(fsClient, directory, config.tasksDir, "queued", log)
    // CONFIRMED strays only: the listing can lag the real FS (and skips
    // unparseable files), and a request written after it — the hub's Plan
    // button, mid-doctor — must never be judged against it.
    const strayRequests = await confirmedStrayPlanRequestIds(
      sh,
      directory,
      config.tasksDir,
      queuedNow.map((t) => t.id),
      "queued",
      log,
    )
    // Allowlist deny telemetry: what the enforcement seams refused, aggregated
    // with the config change that would admit it — the report that used to take
    // stage-transcript archaeology (a starved stage's deny dump).
    const denyFindings = aggregateDenials(readDenyLog(directory, config.tasksDir), (dkind: string, dstage: string) => {
      try {
        // The same composition the stage marker writes (`stageBashGlobs`), so
        // the report is judged against the list that actually refused the
        // command — see the helper for what the missing prefix twins cost.
        return stageBashGlobs(stageDef(manifestFor(dkind).manifest, dstage), platformFor(config, dkind), config)
      } catch {
        return null
      }
    })
    const report = {
      findings: formatAnomalies(anomalies, config.tasksDir),
      heldClaims,
      ...(strayRequests.length ? { strayPlanRequests: strayRequests } : {}),
      ...(denyFindings.length ? { deniedCommands: formatDenyFindings(denyFindings) } : {}),
      ...(anomalies.duplicates.length ? { note: "duplicates are never auto-fixed — keep one copy, workflow_move the rest to abandoned" } : {}),
    }
    if (!fix)
      return ok({
        ...report,
        next:
          hasAnomalies(anomalies) || Object.keys(heldClaims).length || denyFindings.length
            ? "workflow_doctor with fix:true applies the unambiguous repairs"
            : "backlog is clean",
      })

    const actor = await gitActor(sh, directory)
    const rescued: string[] = []
    const failed: string[] = []
    for (const stray of anomalies.strayFiles) {
      try {
        const { id, path: newPath } = await rescueStray(sh, directory, config.tasksDir, stray)
        await appendNote(sh, { id, path: newPath }, auditNote(`Rescued from ${stray} — was outside every status folder`, new Date(), actor), log)
        rescued.push(stray)
      } catch (err) {
        failed.push(`${stray}: ${(err as Error).message}`)
      }
    }
    const removedDirs: string[] = []
    for (const dir of anomalies.unknownDirs) {
      const out = await sh`rmdir ${path.join(directory, config.tasksDir, dir)}`.quiet().nothrow()
      if (out.exitCode === 0) removedDirs.push(dir)
    }
    const releasedClaims: Record<string, string[]> = {}
    for (const status of ["queued", "in-progress"] as const) {
      const ids = heldClaims[status] ?? []
      if (!ids.length) continue
      const tasks = await listByStatus(fsClient, directory, config.tasksDir, status, log)
      // Liveness must be judged ACROSS processes, not just in this one.
      // `active` is this server's own loop, so a task driven by the OpenCode
      // host (or a second Claude session) reads as "not driving" here — and
      // paired with `isOrphanedStartedClaim`, which ignores the CLAIMED/BUILD
      // body on purpose, doctor would release a LIVE drive's claim once its
      // marker aged past the window. The stage marker is the cross-process
      // witness (deadline + writer pid), the same oracle the hub's doctor
      // uses; a dead or expired one still releases, so the wedged markers
      // doctor exists for are unaffected.
      const liveDriven = new Set<string>()
      for (const id of ids) {
        if (await taskDrivenByStageMarker(sh, directory, config.tasksDir, id)) liveDriven.add(id)
      }
      const released = await releaseOrphanedClaims(sh, tasks, ids, path.join(directory, config.tasksDir, status), {
        isDriving: (id) => active?.task?.id === id || liveDriven.has(id),
        staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
        // The window above is a proxy for "the claimer died"; the stamp can
        // often prove it. Without this, doctor — the fallback the gate verbs
        // send users to — could not clear a wedged marker for 75 minutes even
        // when its process was demonstrably gone.
        writerDead: (ref) => claimWriterDead(sh, ref),
        // Doctor releases a stale, undriven marker whatever the body says
        // (`isOrphanedStartedClaim`) — the default rule's `isClaimable` gate
        // made doctor useless against exactly the wedged markers the gate
        // verbs send users here for.
        isOrphaned: status === "queued" ? isOrphanedPlanClaim : isOrphanedStartedClaim,
      })
      if (released.length) releasedClaims[status] = released
    }
    // Unlike a claim, a stray request is never ambiguous: its task has left the
    // folder, so nothing can be driving it. No liveness check, and no commit —
    // the markers were never tracked. Only the CONFIRMED strays from above are
    // revoked; a request written since is left alone.
    const revokedRequests = await revokeStrayPlanRequests(sh, directory, config.tasksDir, strayRequests)
    // Deny telemetry is acknowledged by a fix: the report above carries the
    // aggregate, so the raw log is cleared rather than re-reported forever.
    const denyLogCleared = denyFindings.length ? clearDenyLog(directory, config.tasksDir) : false
    if (rescued.length) {
      await coreCommitBacklog(sh, directory, config, `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
    }
    return ok({
      ...report,
      repaired: { rescued, removedDirs, releasedClaims, ...(revokedRequests.length ? { revokedRequests } : {}), ...(denyLogCleared ? { denyLogCleared } : {}) },
      ...(failed.length ? { failed } : {}),
    })
  },
)

/**
 * The human gate moves — approve (task), approve-plan, replan, ship — now live in
 * @agentic-workflow/core/workflow/gate, shared with the OpenCode driver. These thin
 * adapters bind this host's substrate into the shared `GateCtx` and keep the exact
 * signatures the MCP tools + the deterministic `gate` CLI already call. `replan`/
 * `reject` take the id a live loop is driving explicitly (the MCP tool's `active`;
 * the CLI's on-disk stage marker); the rest use the default `active`-based liveness.
 */
const approveTask = (id: string): Promise<GateResult> => coreApproveTask(gateCtx(), id)
const approvePlan = (id: string): Promise<GateResult> => coreApprovePlan(gateCtx(), id)
const approveAny = (id: string, publish?: ShipPublish, base?: string, autoPlan?: boolean, all?: boolean): Promise<GateResult> =>
  coreApproveAny(gateCtx(), id, "engineering", publish, base, autoPlan, all)
const shipAny = (id: string, publish?: ShipPublish, base?: string): Promise<GateResult> => coreShipAny(gateCtx(), id, "engineering", publish, base)
const replanTask = (id: string, reason: string | undefined, liveTaskId: string | null): Promise<GateResult> =>
  coreReplanTask({ ...gateCtx(), isDriving: (x) => x === liveTaskId }, id, reason)
const rejectAny = (arg: string, liveTaskId: string | null): Promise<GateResult> =>
  coreRejectAny({ ...gateCtx(), isDriving: (x) => x === liveTaskId }, arg)
const retaskTask = (id: string, reason: string | undefined, liveTaskId: string | null): Promise<GateResult> =>
  coreRetaskTask({ ...gateCtx(), isDriving: (x) => x === liveTaskId }, id, reason)
const removeTask = (id: string, liveTaskId: string | null, force = false): Promise<GateResult> =>
  coreRemoveTask({ ...gateCtx(), isDriving: (x) => x === liveTaskId }, id, force)
const abandonTask = (id: string, reason: string | undefined, liveTaskId: string | null): Promise<GateResult> =>
  coreAbandonTask({ ...gateCtx(), isDriving: (x) => x === liveTaskId }, id, reason)

/**
 * The candidates on a gate result's `data` (an ambiguity's choices, or a task
 * gate's remaining slices), or [] when the list is unusable — a non-array, or an
 * entry missing a field the prose interpolates.
 *
 * One malformed entry discards the WHOLE list rather than being filtered out: a
 * partial list would silently hide the very task the human meant, while the plain
 * message it falls back to still says everything core knows. Mirrors
 * `usableCandidates` in hooks/gate-ask.mjs — the two paths must not disagree
 * about which payloads are renderable.
 */
interface GateCandidateLike {
  readonly id: string
  readonly title: string
  readonly from: string
  readonly epic?: string
}
const gateCandidates = (value: unknown): GateCandidateLike[] => {
  if (!Array.isArray(value) || !value.length) return []
  const shaped = (c: unknown): c is GateCandidateLike => {
    const o = c as Record<string, unknown> | null
    return !!o && typeof o === "object" && typeof o.id === "string" && !!o.id && typeof o.title === "string" && typeof o.from === "string" && !!o.from
  }
  return value.every(shaped) ? (value as GateCandidateLike[]) : []
}

/**
 * The gate ask, for the path where the model called the tool instead of typing
 * the verb.
 *
 * The typed verb is intercepted by the `UserPromptSubmit` gate hook, which
 * appends its own follow-up (hooks/gate-ask.mjs) after a task gate. Nothing
 * intercepts a tool call, so without this the same move asks the same question
 * on one path and stays silent on the other — and which path a run takes is not
 * something a human chose. Same wording, same tool name, same host dialect as
 * `runPark`'s plan gate emits.
 *
 * Returns undefined for the terminal ship gate (nothing follows) and for a
 * result that named no gate, so the caller keeps whatever `next` core wrote.
 */
const gateNext = (data: Record<string, unknown>): string | undefined => {
  const id = typeof data.id === "string" ? data.id : null
  if (!id) return undefined
  if (data.gate === "task") {
    // The slice walk, when core reported one. Only the "no" arm continues it: on
    // "yes" the PLAN pass owns the rest of the turn, so the remaining slices are
    // reported rather than offered.
    const rest = gateCandidates(data.siblings)
    const walk = rest.length
      ? ` This is a slice set with ${rest.length === 1 ? "1 slice" : `${rest.length} slices`} still un-approved ` +
        `(${rest.map((c) => `"${c.id}"`).join(", ")}) — on no, ask ONE more ${dialect.askTool}: "Approve \`${rest[0]!.id}\` now?" ` +
        `(${rest[0]!.title}), and on approve call workflow_approve({id: "${rest[0]!.id}"}) and follow its own next; on yes, name the remaining slices and stop.`
      : ""
    return (
      `task gate: the task is queued. Ask the user with ${dialect.askTool} — "Plan \`${id}\` now?" — and on yes run the PLAN pass ` +
      `(workflow_start("${id}"), spawn workflow-plan-author with the prompt it returns, then workflow_advance); on no, stop and report it queued.${walk}`
    )
  }
  if (data.gate === "plan")
    return (
      `plan gate: the plan is approved and the task is build-ready. Ask the user with ${dialect.askTool} — "Build \`${id}\` now?" — ` +
      `and on yes run workflow_start("${id}"); on no, stop (/agentic-workflow:engineering claim builds it later).`
    )
  return undefined
}

/**
 * The pick-one ask for an id-less approve that found several candidates — the
 * tool-path twin of hooks/gate-ask.mjs's `GATE AMBIGUITY` block.
 *
 * Nothing moved (core's `resolveGateTask` only lists), so inviting the model to
 * ask and then approve is a FIRST move on an id the human picked, not a retry of
 * one already made. Returns undefined for every other refusal, which is what
 * keeps this from becoming "invite a retry on any failure".
 */
const gatePickText = (data: Record<string, unknown> | undefined): string | undefined => {
  if (!data?.ambiguous) return undefined
  const candidates = gateCandidates(data.candidates)
  if (candidates.length < 2) return undefined
  // An `in-review` option is a SHIP: the option text must say so, because the
  // human is choosing from one flat list where every other pick is reversible.
  const options = candidates.map((c) => `\`${c.id}\` — ${c.title} (${c.from}${c.from === "in-review" ? " — picking it SHIPS the task: completed/, push, PR" : ""}${c.epic ? `, slice of epic \`${c.epic}\`` : ""})`).join("; ")
  return (
    `NOTHING HAS MOVED, and this plugin never guesses which task was meant. Ask the user with ${dialect.askTool} — ` +
    `"Which task should \`approve\` advance?" — with one option per candidate, in this order: ${options}; plus "None — leave them all". ` +
    `On a pick, call workflow_approve with that exact id and follow the \`next\` it returns. On "None", report that nothing moved and stop.`
  )
}

/** Fold the gate ask into a gate result — the follow-up on a success, the pick-one on an ambiguity. */
const okGate = (r: GateResult) => {
  if (!r.ok) {
    const pick = gatePickText(r.data)
    return fail(pick ? `${r.message}\n\n${pick}` : r.message)
  }
  const next = gateNext(r.data)
  return ok(next ? { ...r.data, next } : r.data)
}

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
server.registerTool(
  "workflow_task_approve",
  {
    description:
      "Deterministic /agentic-workflow:engineering approve <id> on a draft — the task gate: move a reviewed draft/ task to queued/ (audited note + commit). No plan is required or expected; the loop's PLAN stage writes it right before execution. The agent writes nothing. Prefer workflow_approve (the unified gate) unless you specifically need the draft-only form.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approveTask(id)
    return okGate(r)
  },
)

server.registerTool(
  "workflow_plan_approve",
  {
    description:
      "Deterministic /agentic-workflow:engineering approve <id> — the plan gate: validate the plan-review/ task has an ## Implementation Plan, move it to in-progress/ (the build-ready queue), append an audited note, and commit. Refuses planless tasks. The agent writes nothing. Prefer workflow_approve (the unified gate).",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approvePlan(id)
    return okGate(r)
  },
)

server.registerTool(
  "workflow_replan",
  {
    description:
      "Deterministic /agentic-workflow:engineering replan <id> [reason] — the sole rejection verb: reject a parked plan (plan-review/) or send a cap-tripped in-progress/ task back to queued/ with an audited note, marked plan-next so the very next PLAN pass — chain one now with workflow_start({id}) — addresses why the old plan failed and re-parks a revised plan. Refuses tasks a live loop is driving.",
    inputSchema: { id: z.string().min(1), reason: z.string().max(500).optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    const r = await replanTask(id, reason, active?.task?.id ?? null)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_retask",
  {
    description:
      "Deterministic half of /agentic-workflow:engineering retask <id> — puts the task where the authoring interview can reshape it. A draft/ task is already there (no-op). An approved queued/ task is sent BACK to draft/ with an audited note, withdrawing the task-gate approval: the reshaped goal must be re-approved. A superseded plan a prior replan left on the task is removed as part of the move (it was written against the goal you are about to rewrite), and the result says whether that happened. `reason` is recorded on that audit note, so why the task is being reshaped survives in the file rather than only in your turn's context. Refuses from plan-review/ onward (a task with a plan goes back via workflow_replan), tasks a live loop is driving, and tasks holding a claim marker. Call this BEFORE running the interview; the reshape itself is your work, writing draft/<id>.md in place.",
    inputSchema: { id: z.string().min(1), reason: z.string().max(500).optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    const r = await retaskTask(id, reason, active?.task?.id ?? null)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_abandon",
  {
    description:
      "Deterministic /agentic-workflow:engineering abandon <id> — cancel a task by moving it to abandoned/, the terminal folder for work that will not be done. The REVERSIBLE cancellation and the one to prefer: the task file is kept (it can be moved back), unlike workflow_remove which deletes it. Works from any non-terminal status folder; refuses a completed task (shipped work isn't cancellable) and one a live loop is driving or that holds a claim marker. Releases any worktree the task owned. This is also how a tracking epic draft is closed once every child has shipped. The agent writes nothing.",
    inputSchema: { id: z.string().min(1), reason: z.string().optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    const r = await abandonTask(id, reason?.trim() || undefined, active?.task?.id ?? null)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_remove",
  {
    description:
      "Deterministic /agentic-workflow:engineering remove <id> — hard-delete a task from the backlog entirely. Unlike replan/retask/abandon this does NOT move the task to another folder: the file is removed and the removal committed. Works from ANY status folder — a stale draft, a rejected plan, a finished task. Refuses a task a live loop is driving or one holding a claim marker; releases any worktree the task owned. Idempotent: an id that no longer resolves reports success (alreadyDone). REQUIRES force: true to actually delete — without it this reports which task the id resolved to and deletes nothing, which is the confirmation step (ids are prefix-resolvable, so a typo'd short handle can name a different real task). Recovery from git exists ONLY when the backlog is tracked, and ignoreBacklog defaults to true, so a forced remove is usually permanent — prefer workflow_abandon unless the human explicitly wants the file gone.",
    inputSchema: { id: z.string().min(1), force: z.boolean().optional() },
  },
  async ({ id, force }) => {
    await loadCfg()
    const r = await removeTask(id, active?.task?.id ?? null, force === true)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

/**
 * The `publish` argument the two ship-capable gate tools share.
 *
 * Optional everywhere, and an omitted value is NOT "pr" — it means "whatever the
 * repo's `shipPublish` says", which `shipPublishFor` resolves in core. Sending a
 * literal default from here would silently override a repo that configured
 * something else.
 */
const publishArg = z.enum(SHIP_PUBLISH_MODES).optional()

/**
 * The `base` argument the two ship-capable gate tools share — the branch the PR
 * should TARGET.
 *
 * Same omitted-is-not-a-default rule as `publishArg`, and one rung stronger: the
 * gate already knows the ref the run was cut from and graded its diff against, so
 * a value invented here would retarget the PR away from the change the human
 * approved. Pass it only when the human named a branch.
 */
const baseArg = z.string().optional()

const PUBLISH_DOC =
  "base (OPTIONAL) is the branch the pull request should TARGET, e.g. \"release/2.4\". Omit it and the gate uses the base the run was cut from (recorded on the task), then the repo's configured prBase, then the platform's default branch \u2014 pass a value ONLY when the human named one, since inventing one retargets the PR away from the diff that was reviewed. A base that does not exist on origin refuses the PR rather than silently opening it elsewhere. publish (OPTIONAL) chooses what leaves the machine when the gate ships a task: \"pr\" pushes the branch and opens a draft PR, \"push\" pushes the branch and opens nothing, \"local\" does neither and leaves the branch untouched on this machine. Omit it to use the repo's configured shipPublish (default \"pr\") — do not pass a value the human did not choose. The task is completed either way; only publishing varies, and a push/local ship can be published later by shipping the same id again with publish \"pr\"."

server.registerTool(
  "workflow_approve",
  {
    description:
      "/agentic-workflow:engineering approve [id] — the unified, folder-driven gate. With an explicit id it advances that task by its folder's gate: draft/ → queued (task gate), plan-review/ → in-progress (plan gate, requires an ## Implementation Plan), or in-review/ → completed (ship). An explicit id naming an already-completed/ task re-runs its publish step, which is how a push/local ship opens its PR later. The id is OPTIONAL — omit it to advance the single task at a loop wait-gate (plan-review/ or in-review/), falling back to a lone draft/ task only when neither has anything waiting; tracking epics are never auto-resolved, and the id-less form never picks a completed task. Prefer this over the specific workflow_task_approve / workflow_plan_approve / workflow_ship tools. The agent writes nothing. " +
      PUBLISH_DOC,
    inputSchema: {
      id: z.string().optional(),
      publish: publishArg,
      base: baseArg,
      autoPlan: z
        .boolean()
        .optional()
        .describe(
          "Task gate only, and only when the user explicitly asked for --auto-plan: when this task's plan later parks, the plan gate is crossed automatically and BUILD follows. Never add it on your own - it removes a human review the user did not choose to skip. A replan or a fresh approve clears it; the ship gate is never automated.",
        ),
      all: z
        .boolean()
        .optional()
        .describe(
          "Task gate only, and only when the user explicitly asked for --all: approve EVERY reviewed draft (priority order, tracking epics excluded) instead of one. Never add it on your own - it approves drafts the user may not have read. Takes no id; the plan and ship gates stay one-at-a-time.",
        ),
    },
  },
  async ({ id, publish, base, autoPlan, all }) => {
    await loadCfg()
    const r = await approveAny((id ?? "").trim(), publish, base, autoPlan, all)
    return okGate(r)
  },
)

server.registerTool(
  "workflow_reject",
  {
    description:
      "/agentic-workflow:engineering replan [id] [reason] — the folder-driven rejection shortcut. Sends a parked plan back to queued/ marked plan-next (the counterpart of workflow_approve at the plan gate) — chain the re-plan now with workflow_start({id}) so a revised plan re-parks in plan-review/. Auto-targets the single plan-review/ task when no id is given; an explicit id may also name a cap-tripped in-progress/ task. The reason is recorded in the audit note. Refuses a task a live loop is driving.",
    inputSchema: { id: z.string().optional(), reason: z.string().max(500).optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    // Rejoin id + reason into one arg so rejectAny can decide whether the leading token is an id or reason.
    const arg = [id ?? "", reason ?? ""].join(" ").trim()
    const r = await rejectAny(arg, active?.task?.id ?? null)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_move",
  {
    description:
      "Move a task file to another status folder. The low-level escape hatch — prefer the gate verbs (workflow_task_approve / workflow_plan_approve / workflow_replan / workflow_ship / workflow_abandon), which also write the audit note, commit, and open the PR. Refuses a task a loop is driving or that holds a claim marker.",
    inputSchema: { id: z.string(), status: z.enum(["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"]) },
  },
  async ({ id, status }) => {
    await loadCfg()
    // Every sibling move routes through core's gate ops, which resolve the
    // short-hash handle and refuse a task that is being driven or still holds a
    // claim. This one moved the file straight out from under a live loop:
    // `active.task.path` then pointed at a path that no longer existed, so every
    // later appendNote/snapshot/terminal move in workflow_advance missed, and the
    // claim marker was orphaned in the folder the task had left.
    const resolved = await resolveTaskIdAnywhere(sh, directory, config.tasksDir, id, log)
    if (resolved && "ambiguous" in resolved) {
      return fail(`Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`)
    }
    if (resolved) id = resolved.id
    const found = await findAnyStatus(id)
    if (!found) return fail(`No task "${id}".`)
    if (active?.task?.id === id) {
      return fail(`Task "${id}" is being driven by a live loop — workflow_stop it first, or use the gate verb for the move you want.`)
    }
    const from = path.basename(path.dirname(found.path))
    const held = await listClaimIds(sh, directory, config.tasksDir, from)
    if (held.includes(id)) {
      return fail(`Task "${id}" holds a claim marker — a loop may be driving it; stop it or run workflow_doctor fix first.`)
    }
    let newPath: string
    try {
      newPath = await moveTask(sh, { id, path: found.path }, status)
    } catch (err) {
      // moveTask throws on a duplicate destination, a failed mv, or a move that
      // did not land — none of which may escape a tool whose contract is ok/fail.
      return fail(`Can't move "${id}" to ${status}/: ${(err as Error).message}`)
    }
    // A parked task can own a worktree; a move into a terminal folder frees it,
    // the way remove/abandon/ship do. Best-effort, never throws.
    if (status === "completed" || status === "abandoned") await releaseWorktree(sh, log, directory, config, id)
    return ok({ moved: newPath })
  },
)

server.registerTool(
  "workflow_ship",
  {
    description:
      "Ship a reviewed task: move it in-review/ → completed/ with an audited note and commit. The final human gate action. The id is OPTIONAL — omit it to ship the single in-review/ task; pass it only to disambiguate. Passing the id of an ALREADY completed/ task re-runs only its publish step — that is the publish-later path for a push/local ship, and a no-op once a PR is on record. /agentic-workflow:engineering approve (workflow_approve) does the same when the only awaiting task is in in-review/. " +
      PUBLISH_DOC,
    inputSchema: { id: z.string().optional(), publish: publishArg, base: baseArg },
  },
  async ({ id, publish, base }) => {
    await loadCfg()
    const r = await shipAny((id ?? "").trim(), publish, base)
    return r.ok ? ok({ ...r.data, message: r.message }) : fail(r.message)
  },
)

server.registerTool(
  "workflow_recover",
  {
    description:
      "Resume an interrupted in-progress task from its state snapshot (exact stage) or, failing that, from its persisted plan at BUILD. Refuses never-started tasks (use workflow_start/workflow_claim) and planless ones (re-plan first). Returns the next action + prompt.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${workflowId(active)}" — finish or workflow_stop it first.`)
    // Accept the short-hash handle, same as workflow_start and the gate tools.
    const resolved = await resolveTaskIdAnywhere(sh, directory, config.tasksDir, id, log)
    if (resolved && "ambiguous" in resolved) {
      return fail(`Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`)
    }
    if (resolved) id = resolved.id
    const t = await findByIdIn(sh, directory, config.tasksDir, "in-progress", id)
    if (!t) return fail(`No in-progress task "${id}".`)
    if (isClaimable(t)) return fail(`Task "${id}" never started — start it with workflow_start or workflow_claim.`)
    if (!isRecoverable(t)) return fail(`Task "${id}" has no Implementation Plan — send it back to planning with workflow_replan.`)
    // Re-claim. A held marker no longer means "leftover from the dead run" —
    // graceful stops release it — so a failed claim means either a live loop in
    // another process (its stage marker is fresh: refuse, or two loops build
    // the same branch) or a hard-crashed run (take the marker over atomically).
    let tookClaim = await claimTask(sh, t)
    if (!tookClaim) {
      const liveHost = await taskDrivenByStageMarker(sh, directory, config.tasksDir, id)
      if (liveHost) {
        return fail(`Task "${id}" is being driven by a live ${liveHost} loop (fresh stage marker) — stop that loop first, or wait out its stage deadline.`)
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
      const namedByMarker = await taskNamedByStageMarker(sh, directory, config.tasksDir, id)
      // Skipped when the marker already settled it — the probe costs subprocesses.
      const writer = namedByMarker ? "unknown" : await claimWriterState(sh, t)
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
      tookClaim = namedByMarker
        ? (await claimTaskSweepingDeadWriter(sh, t)) || (await claimTaskSweepingStale(sh, t, STALE_CLAIM_MINUTES))
        : writer === "dead"
          ? await claimTaskSweepingDeadWriter(sh, t)
          : await claimTaskSweepingStale(sh, t, STALE_CLAIM_MINUTES)
      if (!tookClaim) {
        return fail(
          namedByMarker || writer === "dead"
            ? `Task "${id}"'s claim marker was just re-taken by another process — nothing to recover.`
            : writer === "alive"
              ? `Task "${id}"'s claim is held by a live process on this machine that has not written a stage marker yet — ` +
                `it is probably still setting up (isolation, dependency install). Stop that run, or retry once its claim goes stale ` +
                `(${STALE_CLAIM_MINUTES} minutes).`
              : `Task "${id}"'s claim is less than ${STALE_CLAIM_MINUTES} minutes old, no stage marker exists yet, and its holder ` +
                `cannot be identified on this machine — the claiming run may still be setting up before its first stage. ` +
                `If you know it is gone, run workflow_doctor with fix:true; otherwise retry once the claim goes stale.`,
        )
      }
    }
    const snap = await loadState(fsClient, directory, config.tasksDir, id)
    resetLoopScratch()
    const actor = await gitActor(sh, directory)
    if (snap && snap.task?.id === id) {
      active = { ...snap, task: { ...snap.task, path: t.path } }
      try {
        active = await ensureIsolation(sh, log, directory, config, active, await resolveBase())
      } catch (err) {
        active = null
        if (tookClaim) await releaseClaim(sh, t)
        return fail((err as Error).message)
      }
      await appendNote(sh, active.task as TaskRef, auditNote(`Recovered from snapshot at ${active.stage}`, new Date(), actor), log)
      const step = firstStep(eng, active, config)
      recordFiredAction(step.action)
      const resumedDef = stageDef(eng.manifest, active.stage)
      const resumedModel = stageModel(eng.manifest.kind, resumedDef)
      return ok({
        resumedFrom: "snapshot",
        stage: active.stage,
        action: step.action,
        agent: agentRef(resumedDef.agent),
        ...(resumedModel ? { model: resumedModel } : {}),
        note: spawnNote(
          "call workflow_stage before spawning the subagent named in the `agent` field",
          resumedDef.kind === "check" ? CHECK_VERDICT_TAIL : "",
        ),
      })
    }
    active = buildEntryState(t)
    try {
      active = await ensureIsolation(sh, log, directory, config, active, await resolveBase())
    } catch (err) {
      active = null
      if (tookClaim) await releaseClaim(sh, t)
      return fail((err as Error).message)
    }
    await appendNote(sh, active.task as TaskRef, auditNote("Recovered from persisted plan — re-entering at BUILD", new Date(), actor), log)
    await snapshot()
    const buildDef = stageDef(eng.manifest, "build")
    const buildModel = stageModel(eng.manifest.kind, buildDef)
    return ok({
      resumedFrom: "plan",
      stage: "build",
      prompt: firePrompt(eng, active, "build"),
      agent: agentRef(buildDef.agent),
      ...(buildModel ? { model: buildModel } : {}),
      note: spawnNote("call workflow_stage before spawning the subagent named in the `agent` field"),
    })
  },
)

// --- deterministic gate CLI ---

/**
 * `node server.js gate <approve|approve-plan|replan> <id> [reason]` — runs one
 * gate move and exits, WITHOUT starting the MCP transport. The UserPromptSubmit
 * hook (hooks/gate-command.mjs) shells to this so the task moves even when a
 * degraded model would not call the equivalent MCP tool. Prints the GateResult
 * as one JSON line to stdout (stdout is otherwise reserved for the MCP protocol;
 * in gate mode it carries only this result — logs still go to stderr).
 */
/**
 * Whether `pid` is a live process on this machine — the gate CLI's twin of the
 * hooks' `markerWriterAlive` (EPERM proves existence, so it counts as alive; a
 * missing or malformed pid reads dead, which for a marker judged by its
 * deadline is the fail-open direction).
 */
const markerPidAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  }
}

const readStageTaskId = (): string | null => {
  try {
    const raw = fs.readFileSync(stageMarkerPath(), "utf8")
    const marker = JSON.parse(raw) as { taskId?: unknown; deadline?: unknown; pid?: unknown }
    if (typeof marker.taskId !== "string") return null
    // A crashed server's leftover marker must not read as "a live loop is
    // driving": nothing removes the file on a SIGKILL/OOM, and this feeds
    // `isDriving` for the typed replan/retask/abandon/remove verbs — core then
    // refuses the task with "stop it first", advice nobody can act on (the
    // restarted server's workflow_stop answers "no active loop" and leaves the
    // marker), wedging the task for good. Same liveness rule as the hooks and
    // core's `taskDrivenByStageMarker`: an expired deadline whose writer pid
    // is gone is a dead run; a marker with no deadline (an older server) stays
    // trusted, and an expired one with a live writer still counts as driving.
    const expired = typeof marker.deadline === "number" && marker.deadline <= Date.now()
    if (expired && !markerPidAlive(marker.pid)) return null
    return marker.taskId
  } catch {
    return null
  }
}

async function runGate(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  const remainder = rest.join(" ").trim()
  const emit = (r: GateResult) => process.stdout.write(`${JSON.stringify(r)}\n`)
  if (!verb) {
    emit({ ok: false, message: "Usage: gate <approve-any|reject-any|approve|approve-plan|replan|retask|abandon|remove> [id] [reason|--pr|--push|--local|--base=<branch>]" })
    return 1
  }
  await loadCfg()
  let result: GateResult
  // Folder-driven shortcuts — id optional (empty remainder → auto-resolve the single awaiting task).
  if (verb === "approve-any") {
    // The id can no longer be "everything after the verb": a publish flag rides
    // in the same words, and joining it into the id would hand core a task id
    // like `t-42 --local` that resolves to nothing. Options out, first bare word
    // in — the shape the `remove` arm below already uses.
    const opts = parseGateOptions(rest)
    if (!opts.ok) {
      emit({ ok: false, message: opts.message })
      return 1
    }
    // The id comes from the parser's leftovers, never from a fresh scan of
    // `rest`: only the parser knows which bare-looking words it consumed.
    result = await approveAny(opts.rest[0] ?? "", opts.publish, opts.base, opts.autoPlan, opts.all)
  } else if (verb === "reject-any") result = await rejectAny(remainder, readStageTaskId())
  else {
    // Legacy verbs require an explicit id.
    const [id, ...reasonParts] = rest
    const reason = reasonParts.join(" ").trim() || undefined
    if (!id) {
      emit({ ok: false, message: "Usage: gate <approve|approve-plan|replan|retask|abandon|remove> <id> [reason|--force]" })
      return 1
    }
    if (verb === "approve") result = await approveTask(id)
    else if (verb === "approve-plan") result = await approvePlan(id)
    else if (verb === "replan") result = await replanTask(id, reason, readStageTaskId())
    else if (verb === "retask") result = await retaskTask(id, reason, readStageTaskId())
    else if (verb === "abandon") result = await abandonTask(id, reason, readStageTaskId())
    // `--force` is remove's confirmation. It arrives as a trailing word from the
    // hook (which parses it, because the hook blocks the turn and no model gets
    // to ask); without it core reports what it would delete and deletes nothing.
    else if (verb === "remove") result = await removeTask(id, readStageTaskId(), reasonParts.includes("--force"))
    else result = { ok: false, message: `Unknown gate verb "${verb}" — expected approve-any, reject-any, approve, approve-plan, replan, retask, abandon, or remove.` }
  }
  emit(result)
  return result.ok ? 0 : 1
}

// --- boot ---

async function main() {
  await loadCfg()
  // Boot reconciliation: prune vanished worktrees, surface survivors (never
  // auto-delete). A worktree whose task is still in-progress or in-review is the
  // NORMAL post-run state (kept until the ship gate releases it) — only one with
  // no such task is genuinely leftover.
  // `taskBranchPrefix` is null in current-branch mode, where the loop cuts no
  // branch — there is nothing here to reconcile, and a `startsWith(null)` sweep
  // would match every branch in the repo.
  const branchPrefix = taskBranchPrefix(config, "engineering")
  if (worktreesDirFor(config, "engineering") && branchPrefix) {
    await pruneWorktrees(sh, directory)
    const worktrees = (await listWorktrees(sh, directory)).filter((w) => w.branch?.startsWith(branchPrefix))
    for (const w of worktrees) {
      const id = w.branch!.slice(branchPrefix.length)
      const active =
        (await findByIdIn(sh, directory, config.tasksDir, "in-progress", id)) ??
        (await findByIdIn(sh, directory, config.tasksDir, "in-review", id))
      if (active) await log("info", `loop worktree ${w.path} (${w.branch}) kept for task ${id} — released when it ships`)
      else await log("info", `leftover loop worktree: ${w.path} (${w.branch}) — no in-progress/in-review task ${id}; /agentic-workflow:engineering recover its task or remove it`)
    }
  }
  await log("info", `agentic-workflow MCP server ready (directory=${directory})`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (process.argv[2] === "gate") {
  runGate(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Fail the CLI cleanly; the hook fails OPEN on a non-zero/broken run so the
      // MCP-tool fallback still moves the task.
      process.stdout.write(`${JSON.stringify({ ok: false, message: `gate failed: ${(err as Error).message}` })}\n`)
      process.exit(1)
    })
} else {
  main().catch((err) => {
    process.stderr.write(`agentic-workflow MCP fatal: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
