#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { stageOrderError } from "./stage-guard.js"
import { staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { DEFAULT_CONFIG, loadConfig } from "@agentic-workflow/core/config"
import { type Action, type Config, type WorkflowState, type TaskRef } from "@agentic-workflow/core/workflow/state"
import { advance, composePrompt, composePromptWithStats, firstStep } from "@agentic-workflow/core/workflow/engine"
import { registerEngineeringHooks } from "@agentic-workflow/core/kinds/engineering"
import { defaultWorkflowsDir } from "@agentic-workflow/core/manifest/dir"
import { effectiveAllowlist, stageDef, type LoadedManifest, type StageDef } from "@agentic-workflow/core/manifest/schema"
import { pollOnce } from "@agentic-workflow/core/scheduler/scheduler"
import { appendSchedulerEvents, skipSetKey, type SchedulerEvent } from "@agentic-workflow/core/scheduler/events-log"
import {
  buildEntryState,
  buildWorkSources,
  workflowWorkTree,
  makeManifestCache,
  planEntryState,
} from "@agentic-workflow/core/workflow/orchestrate"
import type { PolledClaim } from "@agentic-workflow/core/scheduler/scheduler"
import type { WorkSource } from "@agentic-workflow/core/source/types"
import {
  enabledWorkflowKinds,
  fanoutOverriddenByLenses,
  modelFor,
  passAxes,
  platformFor,
  spawnAlias,
  stagePasses,
  unbindableAgentModels,
  unknownAgentModelKeys,
  unknownStageContextKeys,
  unknownStageFanoutKeys,
  unknownStageModelKeys,
  unreviewedAxes,
} from "@agentic-workflow/core/config"
import {
  admitVerdict,
  axisVerdict,
  effectiveVerdict,
  parseVerdict,
  passFocusBlock,
  stageDriftNote,
  uncoveredAxes,
  withCoverageGap,
  type AxisResult,
  type CriterionResult,
  type StagePass,
  type Verdict,
  type VerdictRecord,
} from "@agentic-workflow/core/workflow/verdict"
import { renderRunSummary, type Outcome, type StageSample, verdictStructure } from "@agentic-workflow/core/workflow/metrics"
import { metricsPath, upsertRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import { hostStageMarkerPath, taskDrivenByStageMarker } from "@agentic-workflow/core/workflow/stage-marker"
import { commitAll, commitPaths, currentBranch, gitActor, listWorktrees, pruneWorktrees } from "@agentic-workflow/core/workflow/git"
import { ensureIsolation, releaseWorktree, workflowId } from "@agentic-workflow/core/workflow/isolate"
import {
  approveAny as coreApproveAny,
  approvePlan as coreApprovePlan,
  approveTask as coreApproveTask,
  findAnyStatus as coreFindAnyStatus,
  rejectAny as coreRejectAny,
  abandonTask as coreAbandonTask,
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
  claimTaskSweepingStale,
  findByIdIn,
  isClaimable,
  isOrphanedPlanClaim,
  isOrphanedStartedClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  markClaimed,
  moveTask,
  pairingCoverage,
  refreshClaimStamp,
  releaseClaim,
  releaseOrphanedClaims,
  rescueStray,
  resolveTaskIdAnywhere,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-workflow/core/task/store"
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
 * execution, and only on demand: `workflow_start` on a queued task enters at PLAN
 * (no git isolation — it writes only the task file; `workflow_claim` never
 * auto-plans from `queued/`), and `workflow_advance` after PLAN
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
let verdictRejected = false // whether the current check stage had a verdict REJECTED (incomplete axis coverage) — changes the re-fire wording
let driftNoted = false // whether this stage attempt already audited an out-of-stage verdict (a drifting agent may call repeatedly)
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
let buildNoteFor: string | null = null // `<taskId>:<iteration>` the "BUILD started" note was appended for — a same-stage re-fire must not duplicate it
let samples: StageSample[] = [] // per-run metrics
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
  },
}
const dialect = HOST_DIALECT[HOST]

const stageMarkerPath = () => hostStageMarkerPath(directory, config.tasksDir, HOST)
const verdictNagPath = () => path.join(directory, config.tasksDir, "runs", ".verdict-nag")

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
    // reviewLenses suppresses per-pass axis-coverage enforcement, so turning it
    // on silently downgrades what a review guarantees — name the axes no lens
    // covers rather than let the downgrade pass unremarked.
    for (const def of manifestFor(kind).manifest.stages) {
      const unreviewed = unreviewedAxes(config, def)
      if (!unreviewed.length) continue
      warnings.push(
        `reviewLenses is on, so the ${kind} loop's ${def.name} stage no longer enforces axis coverage, and no lens covers ` +
          `${unreviewed.map((a) => `"${a}"`).join(", ")}. Add ${unreviewed.length > 1 ? "those lenses" : "that lens"} or unset reviewLenses.`,
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
    // Both multi-pass knobs set on one stage: the lenses run and the declared
    // per-axis fan-out does not. Silence would make the fan-out look broken.
    for (const def of manifestFor(kind).manifest.stages) {
      if (!fanoutOverriddenByLenses(config, kind, def)) continue
      warnings.push(
        `reviewLenses is configured, so the ${kind} loop's ${def.name} stage runs the lens passes instead of its declared ` +
          "per-axis fan-out — and per-pass axis coverage is not enforced. Unset reviewLenses to use the fan-out.",
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
  const names = new Set(["workflow-plan-author", "workflow-plan"])
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

/** Flip the stage marker's `verdictRecorded` flag in place once workflow_verdict
 *  lands, so the SubagentStop guard (check-verdict-guard.mjs) stops nagging. */
const stampVerdictRecorded = () => {
  try {
    const m = JSON.parse(fs.readFileSync(stageMarkerPath(), "utf8")) as Record<string, unknown>
    fs.writeFileSync(stageMarkerPath(), JSON.stringify({ ...m, verdictRecorded: true }))
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
 */
const writeStageMarker = (stage: string | null): string | null => {
  const dir = path.join(directory, config.tasksDir, "runs")
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.rmSync(verdictNagPath(), { force: true }) // the nag sentinel belongs to one stage attempt only
    driftNoted = false // likewise the drift note: one per stage attempt, not one per run
    if (stage === null) {
      stageDeadline = null
      fs.rmSync(stageMarkerPath(), { force: true })
    } else {
      const m = activeManifest()
      const def = stageDef(m.manifest, stage)
      stageDeadline = Date.now() + (def.timeoutMinutes ?? config.stageTimeoutMinutes) * 60_000
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
      const allowlist = effectiveAllowlist(def, platform)
      const stageAgentModelMap = stageAgentModels(m)
      fs.writeFileSync(
        stageMarkerPath(),
        JSON.stringify({
          kind: m.manifest.kind,
          stage,
          // The guard's ADO write-backstops key off this (curl to dev.azure.com,
          // plus a best-effort ADO-MCP mutation blocklist).
          platform,
          // The subagent this stage binds, straight from the manifest — the driver
          // (workflow-orchestration SKILL) spawns whatever is named here, so a new kind
          // needs no prose edit.
          agent: def.agent,
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
const gateCtx = (): GateCtx => ({ $: sh, client: fsClient, log, directory, config, isDriving: (id) => active?.task?.id === id })

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
  commitBacklog: async (message) => void (await commitPaths(sh, directory, [config.tasksDir], message)),
  // Worktree checkpoints exclude the backlog dir — the frozen `<tasksDir>` copy
  // must never ride feature/<id> (task-file lifecycle lives on the main tree).
  checkpoint: async (message) =>
    void (await commitAll(sh, workflowWorkTree(directory, state), message, state.git?.worktree ? [config.tasksDir] : undefined)),
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
    { $: sh, client: fsClient, directory, log, isDriving: (id) => active?.task?.id === id, hostName: HOST },
    config,
    manifestFor,
    only,
    target,
  )

/** Claim an approved in-progress task and construct its build-entry state.
 *  Shared by workflow_start and workflow_claim. */
const startTask = async (t: Task): Promise<{ error: string } | { state: WorkflowState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  verdictRetried = false
  verdictRejected = false
  buildNoteFor = null
  // Only workflow_claim sets activeClaim; a stale one left by a claim flow that
  // died mid-setup would fire onTerminal against the WRONG work item at this
  // loop's end. A workflow_start loop has no scheduler claim behind it.
  activeClaim = null
  // Durable claim evidence BEFORE isolation cuts feature/<id>: everything after
  // this commits onto the loop branch, so without it the human branch's task
  // file looks untouched after teardown and the watcher re-claims a task whose
  // work already ran (see store.ts CLAIMED_MARKER).
  await markClaimed(sh, t, await gitActor(sh, directory), log)
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
 *  tree. A died PLAN leaves a stale marker in queued/.claims/ — release it
 *  with workflow_doctor fix, then re-run workflow_start on the task. */
const startPlan = async (t: Task): Promise<{ error: string } | { state: WorkflowState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  verdictRetried = false
  verdictRejected = false
  buildNoteFor = null
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
            "PLAN stage: spawn the subagent named in the `agent` field in task mode",
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
      "Claim the next item and start it — the pull equivalent of the OpenCode plugin's /agentic-workflow:engineering watch. Polls all enabled workflow kinds in claim-priority order (engineering, then any opted-in kind — every sitter is opt-in via workflows.<kind>.enabled); pass `kind` to restrict the pull to one kind (e.g. /agentic-workflow:engineering claim pr-sitter). For engineering it claims build-ready in-progress/ work only (lowest priority number first) — planless queued/ tasks are never auto-planned; plan them with workflow_start({id}). Pass `target` (a PR number) with a PR-sitter `kind` to force that exact PR — it is claimed and driven even with no outstanding attention signal, overriding the poller's heuristic (the fork-PR refusal still holds). Returns null when nothing is claimable.",
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
    samples = []
    pending = null
    verdictRetried = false
    verdictRejected = false
    buildNoteFor = null
    const loaded = manifestFor(claim.item.workflowKind)
    if (stageDef(loaded.manifest, state.stage).isolation !== "none") {
      try {
        // Task-backed claims get the durable CLAIMED note on the human branch
        // before feature/<id> is cut — same as startTask (see store.ts CLAIMED_MARKER).
        // Inside the try: a throw here must not strand activeClaim, or the NEXT
        // loop's terminal would fire onTerminal against this stale item.
        if (state.task) {
          await markClaimed(sh, state.task, await gitActor(sh, directory), log)
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
      return ok({ prompt: composePrompt(activeManifest(), active, stage, config) })
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
      reason: z.string().max(500).optional(),
      criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean() })).optional(),
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
    },
  },
  async ({ stage, verdict, reason, criteria, axes }) => {
    if (!active) return fail("No active loop — verdict ignored.")
    if (active.stage !== stage) {
      // The rejection alone reaches only the calling agent. Audit it on the task
      // so a work stage that ran a later stage's work inside its own turn is
      // visible in the trail, not just as odd behavior one stage later.
      if (!driftNoted && active.task) {
        driftNoted = true
        await appendNote(sh, active.task, auditNote(stageDriftNote(active.stage, stage, verdict), new Date(), await gitActor(sh, directory)), log)
      }
      return fail(`The loop is at ${active.stage}, not ${stage} — verdict ignored.`)
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
    }
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
    const admission = admitVerdict(rec, passAxes(def, currentPass(stage)), pending)
    if (!admission.ok) {
      verdictRejected = true
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
    if (active?.task) await refreshClaimStamp(sh, active.task)
    lastFireAt = Date.now()
    // Wiping `pending` is right for a FRESH stage and catastrophic mid-fan-out:
    // the orchestrator calls workflow_stage before every pass, so wiping here
    // would leave only the last pass's axis and the coverage gate would ERROR on
    // every run. Merging the passes is the point.
    if (fanoutStage !== stage || !pass.focus) {
      pending = null // no stale verdict may leak into this stage
      verdictRejected = false // ...nor a stale rejection into this stage's re-fire wording
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
    return ok({
      stage,
      agent: agentRef(def.agent),
      ...(model ? { model } : {}),
      worktree: active.git?.worktree ?? null,
      ...(active.isolationWarning ? { isolationWarning: active.isolationWarning } : {}),
      deadlineMinutes: config.stageTimeoutMinutes,
      // A focused pass gets its OWN prompt: the fire payload composed one prompt
      // for the stage, and each pass has to be told which axis it covers.
      ...(pass.focus
        ? {
            focus: pass.focus,
            passIndex: index + 1,
            prompt: firePrompt(activeManifest(), active, stage, `\n\n${passFocusBlock(pass, index, passes.length)}`),
          }
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
    if (isOverdue(stageDeadline, Date.now())) {
      const action: Action = {
        kind: "stop",
        message: `✗ Loop stopped — ${stage} exceeded stageTimeoutMinutes (${config.stageTimeoutMinutes}m). Fix what hung it, then /agentic-workflow:engineering recover the task.`,
      }
      samples.push({
        stage,
        iteration: active.iteration,
        ms: Date.now() - lastFireAt,
        startedAt: new Date(lastFireAt).toISOString(),
        ...promptSizeFields(),
      })
      await runTerminal(action)
      return ok({ action })
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
          }
        : {}),
    })
    flushRunMetrics(workflowId(active)) // publish samples-so-far live to the hub
    // A check stage that ended with NO workflow_verdict call is a broken verdict
    // channel, not a genuine FAIL — re-fire the same check once (no iteration
    // consumed, no rebuild), then stop with a retryable ERROR instead of
    // burning build iterations on a stage that may have passed (the
    // theater-booking-0 failure mode: three rebuilds of an already-done task).
    if (stageDef(activeManifest().manifest, stage).kind === "check" && !pending) {
      // Diagnostic only — free text never flips control flow (verdict.ts).
      const prose = parseVerdict(stageOutput, `WORKFLOW_${stage.toUpperCase()}`)
      if (!verdictRetried) {
        verdictRetried = true
        if (active.task) {
          const noteActor = await gitActor(sh, directory)
          await appendNote(
            sh,
            active.task,
            auditNote(
              `${stage.toUpperCase()} ended with no workflow_verdict call — re-running the check once (prose claimed ${prose ?? "nothing"}; free text is untrusted)`,
              new Date(),
              noteActor,
            ),
            log,
          )
        }
        const refireMarkerError = writeStageMarker(stage) // fresh deadline + verdictRecorded:false for the re-fire
    if (refireMarkerError) return fail(`Could not re-arm the stage marker for "${stage}" — ${refireMarkerError}. The stage is not re-fired.`)
        lastFireAt = Date.now()
        const retryModel = stageModel(activeManifest().manifest.kind, stageDef(activeManifest().manifest, stage))
        return ok({
          action: { kind: "fire", stage },
          agent: agentRef(stageDef(activeManifest().manifest, stage).agent),
          ...(retryModel ? { model: retryModel } : {}),
          prompt: firePrompt(
            activeManifest(),
            active,
            stage,
            (verdictRejected
              ? "\n\nPREVIOUS ATTEMPT'S VERDICT WAS REJECTED and never recorded — it did not cover every required axis, " +
                "or it declared FAIL without naming a critical/important finding. Call workflow_verdict ONCE with the " +
                "COMPLETE axes array; partial submissions are not accumulated."
              : "\n\nPREVIOUS ATTEMPT RECORDED NO VERDICT — the workflow_verdict tool call is MANDATORY. " +
                "If the tool is not in your tool list, state that explicitly in your final message and finish."),
          ),
          note: spawnNote(
            "check retry (no iteration consumed): the previous pass never called workflow_verdict — call workflow_stage, then spawn the stage subagent again",
            CHECK_VERDICT_TAIL,
          ),
        })
      }
      pending = {
        verdict: "ERROR",
        reason:
          "no workflow_verdict recorded even after a retry — the verdict channel is unreachable from the stage subagent " +
          "or the agent contract was not applied; fix the plugin wiring, then recover the task" +
          (prose ? ` (prose claimed ${prose}, ignored — free text is untrusted)` : ""),
      }
    }
    // The completeness gate. Per-pass admission proves each pass covered ITS
    // axis; it can never prove every axis ran, because on THIS host the
    // orchestrator owns the pass loop and can simply skip a spawn. Only the
    // accumulated record shows that — so check it here, re-fire just the missing
    // passes once (no iteration consumed), then stop with ERROR rather than
    // re-build on a review that never happened.
    const gateDef = stageDef(activeManifest().manifest, stage)
    if (gateDef.kind === "check" && pending && passesFor(activeManifest().manifest.kind, gateDef).some((p) => p.mode === "axis")) {
      const gaps = uncoveredAxes(pending, gateDef.requiredAxes)
      if (gaps.length && !verdictRetried) {
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
        // Same rule as every other arm: a re-run the guard cannot scope must not
        // be handed out as if it were scoped.
        const gapMarkerError = writeStageMarker(stage)
        if (gapMarkerError) return fail(`Could not re-arm the stage marker for "${stage}" — ${gapMarkerError}. The gap passes are not re-run.`)
        lastFireAt = Date.now()
        armedPass = null // its sample is already recorded; the retry arms its own
        const gapModel = stageModel(activeManifest().manifest.kind, gateDef)
        return ok({
          action: { kind: "fire", stage },
          agent: agentRef(gateDef.agent),
          ...(gapModel ? { model: gapModel } : {}),
          passes: gaps,
          note: spawnNote(
            `axis retry (no iteration consumed): ${gaps.join(", ")} recorded no verdict — call ` +
              `workflow_stage({stage:"${stage}", focus:"<axis>"}) and spawn the stage subagent again for EACH of them`,
            CHECK_VERDICT_TAIL,
          ),
        })
      }
      if (gaps.length) pending = withCoverageGap(pending, gaps)
    }
    // `advance` threads the structured feedback (reason, failed criteria, failing
    // axes) ahead of the prose for the next iteration and records the seam, so a
    // stage context budget can clamp the prose without touching the block. The
    // fused artifact is byte-identical to what this site used to build by hand.
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      await commitAll(
        sh,
        workTree(),
        `loop(${workflowId(active)}): build checkpoint (iteration ${active.iteration + 1})`,
        active.git?.worktree ? [config.tasksDir] : undefined,
      )
    }
    if (stageDef(activeManifest().manifest, stage).kind === "check" && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      const failedAxes = (pending?.axes ?? []).filter((a) => axisVerdict(a) !== "PASS").map((a) => a.axis)
      const detail = [failed ? `${failed} criteria unmet` : "", failedAxes.length ? `axes: ${failedAxes.join(", ")}` : ""].filter(Boolean).join("; ")
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending ? effectiveVerdict(pending) : "none → FAIL"}${detail ? ` (${detail})` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    // The derived verdict, not the declared one — an agent must not be able to
    // report PASS while flagging a Critical finding on an axis.
    const verdict = stageDef(activeManifest().manifest, stage).kind === "check" ? (pending ? effectiveVerdict(pending) : null) : null
    const { state, action } = advance(activeManifest(), active, config, stageOutput, verdict, pending)
    active = state
    pending = null
    verdictRetried = false // the transition happened — the next check stage gets its own retry budget
    verdictRejected = false
    armedPass = null // no pass of the finished stage may admit a verdict for the next one
    fanoutStage = null

    if (action.kind === "fire") {
      await snapshot()
      const nextDef = stageDef(activeManifest().manifest, action.stage)
      const nextModel = stageModel(activeManifest().manifest.kind, nextDef)
      const nextPasses = passLabels(activeManifest().manifest.kind, nextDef)
      return ok({
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
      })
    }
    if (action.kind === "park") {
      // PLAN finished — validate the plan landed on the task file, then park
      // it in plan-review/ for the human gate and end the loop. No snapshot:
      // PLAN never resumes from one.
      const result = await runPark(action)
      return "error" in result ? fail(result.error) : ok(result)
    }
    // terminal: done / stop
    const taskId = active.task?.id ?? null // runTerminal nulls `active`
    await snapshot()
    const report = await runTerminal(action)
    // A done whose park failed (core reports stop: the move to in-review/ was
    // blocked) must not announce the ship gate — the task is still in
    // in-progress/. Surface core's failure message instead.
    const parked = action.kind !== "done" || report?.kind === "done"
    return ok({
      action: parked
        ? { kind: action.kind, message: (action as { message: string }).message }
        : { kind: "stop", message: report?.message ?? (action as { message: string }).message },
      ...(action.kind === "done" && parked && taskId
        ? {
            taskId,
            gate: { kind: "ship", id: taskId },
            next:
              `ship gate: show the user the loop branch's diff summary, then ask with AskUserQuestion — ` +
              `Ship (workflow_ship("${taskId}")), Replan with a reason (workflow_replan("${taskId}", reason)), ` +
              `or Leave in in-review (stop here; /agentic-workflow:engineering approve ${taskId} ships it later).`,
          }
        : {}),
    })
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
  | { action: { kind: "park"; message: string }; path: string; gate: { kind: "plan"; id: string }; next: string }
> => {
  if (!active) {
    activeClaim = null
    active = null
    writeStageMarker(null)
    return { error: "No task-backed loop to park." }
  }
  const actor = await gitActor(sh, directory)
  const report = await coreRunTerminal(terminalCtx(active, actor), action)
  // A task-less park and a veto/plan-not-landed both leave nothing to review (a park
  // action never yields done/stop, but narrowing keeps the descriptor's types honest).
  if (report.kind !== "park") {
    activeClaim = null // core already released any queued claim
    active = null
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
  writeStageMarker(null)
  return {
    action: { kind: "park", message: action.message },
    path: report.path,
    gate: { kind: "plan", id },
    next:
      `plan gate: show the user the plan summary, then ask with AskUserQuestion — ` +
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
  const report = await coreRunTerminal(terminalCtx(active, actor), action)
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
  return report
}

server.registerTool(
  "workflow_checkpoint",
  { description: "Commit the current build state as a checkpoint on the loop branch/worktree.", inputSchema: { message: z.string() } },
  async ({ message }) => {
    if (!active?.git) return ok({ committed: false, note: "no isolation active" })
    const done = await commitAll(sh, workTree(), message, active.git.worktree ? [config.tasksDir] : undefined)
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
    const summary = summarizeBacklog(byStatus)
    const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
    const pm = config.projectManagement
    return ok({
      active: active ? { stage: active.stage, iteration: active.iteration + 1, task: active.task?.id ?? active.goal } : null,
      backlog: summary,
      kinds: kindsReport(),
      ...(pm ? { pairing: { system: pm.system, ...pairingCoverage(byStatus) } } : {}),
      ...(hasAnomalies(anomalies) ? { anomalies: formatAnomalies(anomalies, config.tasksDir).map((l) => `${l} (workflow_doctor repairs)`) } : {}),
    })
  },
)

server.registerTool(
  "workflow_doctor",
  {
    description:
      "Audit the backlog for structural damage a confused agent can cause: stray folders (not a status folder), task files outside every status folder, duplicate ids across status folders, and held claim markers. With fix:true, performs only the unambiguous repairs — rescue stray .md files back to draft/ (audited note + commit), remove now-empty stray folders, and release stale orphaned claim markers. Duplicates are always flagged for a human, never auto-resolved.",
    inputSchema: { fix: z.boolean().optional().describe("Apply the unambiguous repairs instead of only reporting.") },
  },
  async ({ fix }) => {
    await loadCfg()
    const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
    const heldClaims: Record<string, string[]> = {}
    for (const status of ["queued", "in-progress"] as const) {
      const ids = await listClaimIds(sh, directory, config.tasksDir, status)
      if (ids.length) heldClaims[status] = ids
    }
    const report = {
      findings: formatAnomalies(anomalies, config.tasksDir),
      heldClaims,
      ...(anomalies.duplicates.length ? { note: "duplicates are never auto-fixed — keep one copy, workflow_move the rest to abandoned" } : {}),
    }
    if (!fix) return ok({ ...report, next: hasAnomalies(anomalies) || Object.keys(heldClaims).length ? "workflow_doctor with fix:true applies the unambiguous repairs" : "backlog is clean" })

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
      const released = await releaseOrphanedClaims(sh, tasks, ids, path.join(directory, config.tasksDir, status), {
        isDriving: (id) => active?.task?.id === id,
        staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
        // Doctor releases a stale, undriven marker whatever the body says
        // (`isOrphanedStartedClaim`) — the default rule's `isClaimable` gate
        // made doctor useless against exactly the wedged markers the gate
        // verbs send users here for.
        isOrphaned: status === "queued" ? isOrphanedPlanClaim : isOrphanedStartedClaim,
      })
      if (released.length) releasedClaims[status] = released
    }
    if (rescued.length) {
      await commitPaths(sh, directory, [config.tasksDir], `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
    }
    return ok({ ...report, repaired: { rescued, removedDirs, releasedClaims }, ...(failed.length ? { failed } : {}) })
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
const approveAny = (id: string): Promise<GateResult> => coreApproveAny(gateCtx(), id)
const shipAny = (id: string): Promise<GateResult> => coreShipAny(gateCtx(), id)
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
    return r.ok ? ok(r.data) : fail(r.message)
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
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_replan",
  {
    description:
      "Deterministic /agentic-workflow:engineering replan <id> [reason] — the sole rejection verb: reject a parked plan (plan-review/) or send a cap-tripped in-progress/ task back to queued/ with an audited note, so the next PLAN pass addresses why the old plan failed. Refuses tasks a live loop is driving.",
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
      "Deterministic half of /agentic-workflow:engineering retask <id> — puts the task where the authoring interview can reshape it. A draft/ task is already there (no-op). An approved queued/ task is sent BACK to draft/ with an audited note, withdrawing the task-gate approval: it is planless, so nothing downstream breaks, but the reshaped goal must be re-approved. `reason` is recorded on that audit note, so why the task is being reshaped survives in the file rather than only in your turn's context. Refuses from plan-review/ onward (a task with a plan goes back via workflow_replan), tasks a live loop is driving, and tasks holding a claim marker. Call this BEFORE running the interview; the reshape itself is your work, writing draft/<id>.md in place.",
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

server.registerTool(
  "workflow_approve",
  {
    description:
      "/agentic-workflow:engineering approve [id] — the unified, folder-driven gate. With an explicit id it advances that task by its folder's gate: draft/ → queued (task gate), plan-review/ → in-progress (plan gate, requires an ## Implementation Plan), or in-review/ → completed (ship). The id is OPTIONAL — omit it to advance the single task at a loop wait-gate (plan-review/ or in-review/), falling back to a lone draft/ task only when neither has anything waiting; tracking epics are never auto-resolved. Prefer this over the specific workflow_task_approve / workflow_plan_approve / workflow_ship tools. The agent writes nothing.",
    inputSchema: { id: z.string().optional() },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approveAny((id ?? "").trim())
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "workflow_reject",
  {
    description:
      "/agentic-workflow:engineering replan [id] [reason] — the folder-driven rejection shortcut. Sends a parked plan back to queued/ for re-planning (the counterpart of workflow_approve at the plan gate). Auto-targets the single plan-review/ task when no id is given; an explicit id may also name a cap-tripped in-progress/ task. The reason is recorded in the audit note. Refuses a task a live loop is driving.",
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
  { description: "Ship a reviewed task: move it in-review/ → completed/ with an audited note and commit. The final human gate action. The id is OPTIONAL — omit it to ship the single in-review/ task; pass it only to disambiguate. /agentic-workflow:engineering approve (workflow_approve) does the same when the only awaiting task is in in-review/.", inputSchema: { id: z.string().optional() } },
  async ({ id }) => {
    await loadCfg()
    const r = await shipAny((id ?? "").trim())
    return r.ok ? ok(r.data) : fail(r.message)
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
      tookClaim = await claimTaskSweepingStale(sh, t, 0)
      if (!tookClaim) return fail(`Task "${id}"'s claim marker was just re-taken by another process — nothing to recover.`)
    }
    const snap = await loadState(fsClient, directory, config.tasksDir, id)
    samples = []
    pending = null
    verdictRetried = false
    verdictRejected = false
    buildNoteFor = null
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
const readStageTaskId = (): string | null => {
  try {
    const raw = fs.readFileSync(stageMarkerPath(), "utf8")
    const marker = JSON.parse(raw) as { taskId?: unknown }
    return typeof marker.taskId === "string" ? marker.taskId : null
  } catch {
    return null
  }
}

async function runGate(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  const remainder = rest.join(" ").trim()
  const emit = (r: GateResult) => process.stdout.write(`${JSON.stringify(r)}\n`)
  if (!verb) {
    emit({ ok: false, message: "Usage: gate <approve-any|reject-any|approve|approve-plan|replan|retask|abandon|remove> [id] [reason]" })
    return 1
  }
  await loadCfg()
  let result: GateResult
  // Folder-driven shortcuts — id optional (empty remainder → auto-resolve the single awaiting task).
  if (verb === "approve-any") result = await approveAny(remainder)
  else if (verb === "reject-any") result = await rejectAny(remainder, readStageTaskId())
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
  if (config.worktreesDir) {
    await pruneWorktrees(sh, directory)
    const worktrees = (await listWorktrees(sh, directory)).filter((w) => w.branch?.startsWith("feature/"))
    for (const w of worktrees) {
      const id = w.branch!.slice("feature/".length)
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
