#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { stageOrderError } from "./stage-guard.js"
import { DEFAULT_CONFIG, loadConfig } from "@agentic-loop/core/config"
import { type Action, type Config, type LoopState, type TaskRef } from "@agentic-loop/core/loop/state"
import { advance, composePrompt, firstStep } from "@agentic-loop/core/loop/engine"
import { registerEngineeringHooks } from "@agentic-loop/core/kinds/engineering"
import { defaultLoopsDir } from "@agentic-loop/core/manifest/dir"
import { effectiveAllowlist, stageDef, type LoadedManifest, type StageDef } from "@agentic-loop/core/manifest/schema"
import { pollOnce } from "@agentic-loop/core/scheduler/scheduler"
import {
  buildEntryState,
  buildWorkSources,
  loopWorkTree,
  makeManifestCache,
  planEntryState,
} from "@agentic-loop/core/loop/orchestrate"
import type { PolledClaim } from "@agentic-loop/core/scheduler/scheduler"
import type { WorkSource } from "@agentic-loop/core/source/types"
import { adoAccessFor, bareModel, enabledLoopKinds, modelFor, platformFor } from "@agentic-loop/core/config"
import {
  failedCriteriaBlock,
  parseVerdict,
  stageDriftNote,
  worstOf,
  type CriterionResult,
  type Verdict,
  type VerdictRecord,
} from "@agentic-loop/core/loop/verdict"
import { renderRunSummary, type Outcome, type StageSample } from "@agentic-loop/core/loop/metrics"
import { metricsPath, upsertRunMetrics } from "@agentic-loop/core/loop/metrics-file"
import { commitAll, commitPaths, currentBranch, gitActor, listWorktrees, pruneWorktrees } from "@agentic-loop/core/loop/git"
import { ensureIsolation, loopId } from "@agentic-loop/core/loop/isolate"
import {
  approveAny as coreApproveAny,
  approvePlan as coreApprovePlan,
  approveTask as coreApproveTask,
  findAnyStatus as coreFindAnyStatus,
  rejectAny as coreRejectAny,
  replanTask as coreReplanTask,
  shipAny as coreShipAny,
  type GateCtx,
  type GateResult,
} from "@agentic-loop/core/loop/gate"
import { runTerminal as coreRunTerminal, type TerminalCtx } from "@agentic-loop/core/loop/terminal"
import { loadState, saveState } from "@agentic-loop/core/loop/persist"
import { type Task } from "@agentic-loop/core/task/schema"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimTask,
  findByIdIn,
  isClaimable,
  isOrphanedPlanClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  markClaimed,
  moveTask,
  pairingCoverage,
  releaseOrphanedClaims,
  rescueStray,
  resolveTaskIdAnywhere,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-loop/core/task/store"
import { auditBacklog, formatAnomalies, hasAnomalies } from "@agentic-loop/core/task/audit"
import { isLeaseStale, readLeaseOwner, staleThresholdMs } from "@agentic-loop/core/scheduler/lease"

/**
 * MCP server backing the agentic-loop Claude Code plugin. It holds the loop's
 * LoopState (the same pure state machine the OpenCode driver uses) and exposes
 * the deterministic/trusted operations as tools the MAIN agent calls while it
 * drives BUILD→VERIFY→REVIEW via the Task tool. The autonomous background
 * driver is gone (no Claude Code equivalent) — the agent is the driver; this
 * server is the trusted state + git/backlog substrate.
 *
 * Task authoring happens before the loop, via `/agentic-loop:engineering new`: it interviews
 * the user into a draft (main-agent turn) and `loop_approve` (unified gate)
 * parks it planless in `queued/`. Planning happens inside the loop, right before
 * execution, and only on demand: `loop_start` on a queued task enters at PLAN
 * (no git isolation — it writes only the task file; `loop_claim` never
 * auto-plans from `queued/`), and `loop_advance` after PLAN
 * parks the task in `plan-review/` and ends the loop (`park`). The human plan
 * gate is `loop_plan_approve` (plan-review → in-progress); `loop_replan`
 * sends a rejected or cap-tripped task back to `queued/`. From `in-progress/`
 * — the build-ready queue — claims enter at BUILD.
 *
 * There is no `/agentic-loop:engineering watch` here, deliberately: watch needs an autonomous
 * driver firing stages on idle events/timers, and the MCP server can't spawn
 * subagents. `loop_claim` is the pull equivalent — one human trigger claims
 * the next approved task.
 */

const directory = process.env.AGENTIC_LOOP_DIR ?? process.cwd()
/**
 * Where to read the base branch for a fresh `feature/<id>` worktree. `directory`
 * (the canonical root: backlog + worktree parent) is frozen at server launch
 * on the main checkout — usually the default branch — so worktrees would
 * always cut from it. Point `AGENTIC_LOOP_BASE_DIR` at the tree you actually
 * work in and the base is read there live (per claim). Unset ⇒ core falls back
 * to `directory`'s branch (today's behavior).
 */
const baseDir = process.env.AGENTIC_LOOP_BASE_DIR
const resolveBase = async (): Promise<string | undefined> =>
  baseDir ? ((await currentBranch(sh, baseDir)) ?? undefined) : undefined
/** The loop-kind manifests shipped with core (packages/core/loops/<kind>/) —
 *  resolved from core's own install location so the server works from any cwd
 *  and survives plugin relocations. */
const LOOPS_DIR = defaultLoopsDir()
const manifestFor = makeManifestCache(LOOPS_DIR, ["engineering"])
const eng = manifestFor("engineering")
registerEngineeringHooks()
const log = (level: "info" | "warn" | "error", message: string) =>
  fsClient.app.log({ body: { service: "agentic-loop", level, message } })

// --- shared in-process loop state (one active loop per server/session) ---

let active: LoopState | null = null
let activeClaim: PolledClaim | null = null // the scheduler claim behind `active`, when loop_claim made it
let pending: VerdictRecord | null = null // verdict(s) recorded for the current check stage
let verdictRetried = false // whether the current check stage already got its one no-verdict re-fire
let driftNoted = false // whether this stage attempt already audited an out-of-stage verdict (a drifting agent may call repeatedly)
let samples: StageSample[] = [] // per-run metrics
let lastFireAt = Date.now()
let stageDeadline: number | null = null // wall-clock cap for the stage in flight
let config: Config = DEFAULT_CONFIG

/**
 * Structured twin of the run-log summary — `runs/<id>.metrics.json`. The
 * Claude host never calls the LLM itself (stages run as agent turns), so its
 * entries carry timing/verdicts only; tokens for these runs are joined from
 * the session transcripts by consumers. Best-effort.
 */
const writeRunMetrics = (id: string, outcome: Outcome, detail: string, endedAt: string): void => {
  try {
    const file = metricsPath(directory, config.tasksDir, id)
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    // Upsert: replace the trailing `open` entry the per-stage flush left behind.
    fs.writeFileSync(file, upsertRunMetrics(existing, { endedAt, outcome, detail, host: "claude", samples }))
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
      upsertRunMetrics(existing, { endedAt: new Date().toISOString(), detail: "", host: "claude", samples, open: true }),
    )
  } catch {
    /* telemetry never fails the loop */
  }
}

const loadCfg = async () => {
  try {
    config = await loadConfig(fsClient, directory)
  } catch (err) {
    await log("warn", `using default config: ${(err as Error).message}`)
    config = DEFAULT_CONFIG
  }
}

// --- host wiring (shared helpers live in @agentic-loop/core/loop/orchestrate) ---

const stageMarkerPath = () => path.join(directory, config.tasksDir, "runs", ".stage.json")
const verdictNagPath = () => path.join(directory, config.tasksDir, "runs", ".verdict-nag")

/**
 * Plugin-bundled agents resolve under the plugin namespace in Claude Code —
 * Task's subagent_type is "agentic-loop:<name>", not the bare manifest name.
 * The manifests stay host-neutral; only this host prefixes.
 */
const agentRef = (name: string): string => `agentic-loop:${name}`

/**
 * The stage's configured model in this host's vocabulary (config > manifest,
 * undefined ⇒ host default), with any "provider/" prefix (the OpenCode
 * spelling) stripped so a shared config works on both hosts.
 */
const stageModel = (kind: string, def: StageDef): string | undefined => {
  const m = modelFor(config, kind, def)
  return m ? bareModel(m) : undefined
}

/** Flip the stage marker's `verdictRecorded` flag in place once loop_verdict
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

/** Write the current-stage marker the PreToolUse hook reads to scope the
 *  allowlist and enforce the stage deadline. */
const writeStageMarker = (stage: string | null) => {
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
      // Same stamp-wins rule for the ADO access method: a state claimed under
      // one access must keep that access's allowlist and guard behavior. A
      // stamp-less ado state falls back to "rest" (curl-era claim), matching
      // promptContext's fallback.
      const access = platform === "ado" ? (active?.platformAccess ?? (active ? "rest" : adoAccessFor(config))) : undefined
      const allowlist = effectiveAllowlist(def, platform, access)
      fs.writeFileSync(
        stageMarkerPath(),
        JSON.stringify({
          kind: m.manifest.kind,
          stage,
          // The guard's ADO write-backstops key off these (curl vs az vs mcp).
          platform,
          ...(access ? { access } : {}),
          // The subagent this stage binds, straight from the manifest — the driver
          // (loop-orchestration SKILL) spawns whatever is named here, so a new kind
          // needs no prose edit.
          agent: def.agent,
          // Check stages must record a verdict via loop_verdict before ending;
          // the SubagentStop guard blocks a first stop that hasn't (see
          // check-verdict-guard.mjs). loop_verdict flips verdictRecorded in place.
          check: def.kind === "check",
          verdictRecorded: false,
          // The backlog guard's PLAN carve-out: only this task's queued/ file
          // may be written directly while PLAN is live.
          taskId: active?.task?.id ?? null,
          worktree: active?.git?.worktree ?? null,
          deadline: stageDeadline,
          // 1-indexed to match the "BUILD started (iteration N)" audit notes.
          iteration: active ? active.iteration + 1 : null,
          ...(allowlist.length ? { bashAllowlist: allowlist } : {}),
        }),
      )
    }
  } catch {
    /* best-effort */
  }
}

/** A stage past its wall-clock cap must fail the loop rather than wedge it. Pure. */
const isOverdue = (deadline: number | null, now: number): boolean => deadline !== null && now > deadline

const snapshot = async () => {
  if (active?.task) await saveState(sh, directory, config.tasksDir, active.task.id, active)
}

const workTree = () => (active ? loopWorkTree(directory, active) : directory)

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
 * metrics render into this host's run log + `host: "claude"` sidecar.
 */
const terminalCtx = (state: LoopState, actor: string | null): TerminalCtx => ({
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
    void (await commitAll(sh, loopWorkTree(directory, state), message, state.git?.worktree ? [config.tasksDir] : undefined)),
  writeMetrics: async (outcome, detail) => {
    const stamp = new Date().toISOString()
    const summary = renderRunSummary(samples, outcome, detail, config.maxIterations, stamp)
    await appendRunLog(sh, directory, config.tasksDir, loopId(state), `run · ${outcome}`, summary, log)
    writeRunMetrics(loopId(state), outcome, detail, stamp)
  },
})

/** Locate which status folder a task id lives in. */
const findAnyStatus = (id: string): Promise<Task | null> => coreFindAnyStatus(gateCtx(), id)

/** The work sources loop_claim polls, in claim-priority order (config order).
 *  An `only` kind restricts the poll to that one kind. */
const sourcesFor = (only?: string): WorkSource[] =>
  buildWorkSources(
    // Single active loop per server; a claim only happens when no loop is live.
    { $: sh, client: fsClient, directory, log, isDriving: (id) => active?.task?.id === id },
    config,
    manifestFor,
    only,
  )

/** Claim an approved in-progress task and construct its build-entry state.
 *  Shared by loop_start and loop_claim. */
const startTask = async (t: Task): Promise<{ error: string } | { state: LoopState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  verdictRetried = false
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
    return { error: (err as Error).message }
  }
  active = state
  await snapshot()
  return { state }
}

/** Claim a queued (planless) task and construct its PLAN-entry state. No git
 *  isolation and no snapshot: PLAN writes only the task file, in the main
 *  tree. A died PLAN leaves a stale marker in queued/.claims/ — release it
 *  with loop_doctor fix, then re-run loop_start on the task. */
const startPlan = async (t: Task): Promise<{ error: string } | { state: LoopState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  verdictRetried = false
  const state = planEntryState(t)
  active = state
  // Arm the PreToolUse carve-out for the whole PLAN window: {stage:"plan", taskId}
  // so the loop-plan-author subagent may Edit its own queued/<id>.md. The PLAN
  // path spawns the author straight off loop_start without a loop_stage call, so
  // without this the marker never exists and the one write PLAN exists to make is
  // blocked. loop_advance clears it on park.
  writeStageMarker("plan")
  return { state }
}

/**
 * Warnings a claim should surface: a live foreign watcher's lease (its git
 * operations can race this one-shot claim — threat-model T3 residual) and any
 * backlog anomalies the reconciliation sweep finds. Best-effort; never blocks.
 */
const claimWarnings = async (): Promise<string[]> => {
  const warnings: string[] = []
  const owner = await readLeaseOwner(sh, directory, config.tasksDir)
  if (owner && !isLeaseStale(owner, new Date(), staleThresholdMs(owner.intervalMs))) {
    warnings.push(
      `a live watcher (pid ${owner.pid} on ${owner.host}) holds this clone's watch lease — ` +
        `one-shot claims can race its git operations; prefer running them in separate clones/worktrees.`,
    )
  }
  const anomalies = await auditBacklog(fsClient, directory, config.tasksDir)
  if (hasAnomalies(anomalies)) warnings.push(...formatAnomalies(anomalies, config.tasksDir).map((l) => `${l} (loop_doctor repairs)`))
  return warnings
}

/** The fire payload loop_start/loop_claim return for a fresh claim. */
const firePayload = (state: LoopState, id: string) => {
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
    prompt: composePrompt(manifest, state, state.stage),
    ...(state.stage === "plan"
      ? { note: "PLAN stage: spawn the subagent named in the `agent` field in task mode; on loop_advance the task parks in plan-review/ for the human gate" }
      : {}),
  }
}

// --- server + tools ---

const server = new McpServer({ name: "agentic-loop", version: "0.0.1" })

server.registerTool(
  "loop_start",
  {
    description:
      "Execute one task now. An in-progress/ task (plan approved via loop_plan_approve) is claimed and started at BUILD with git isolation; a queued/ task (approved via loop_task_approve, planless) is claimed and started at PLAN — it will park in plan-review/ for the human plan gate. Returns the composed stage prompt. Entering PLAN arms the stage marker automatically (so the plan-author may write its own queued/ task); call loop_stage right before spawning each later stage subagent.",
    inputSchema: { id: z.string().min(1).describe("The task's id (filename without .md) in in-progress/ or queued/.") },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
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
          ? `Task "${id}" is parked in plan-review/ — approve its plan (loop_plan_approve) or reject it (loop_replan) first.`
          : where === "draft"
            ? `Task "${id}" is a draft — approve it into the queue with loop_task_approve first.`
            : where
              ? `Task "${id}" is in ${where} — only queued or in-progress tasks can be executed.`
              : `No task "${id}" found.`,
      )
    }
    if (!isClaimable(t)) {
      return fail(
        isRecoverable(t)
          ? `Task "${id}" has already started — resume it with loop_recover instead.`
          : `Task "${id}" has no Implementation Plan — send it back to planning with loop_replan.`,
      )
    }
    const started = await startTask(t)
    if ("error" in started) return fail(started.error)
    const warnings = await claimWarnings()
    return ok({ ...firePayload(started.state, id), ...(warnings.length ? { warnings } : {}) })
  },
)

server.registerTool(
  "loop_claim",
  {
    description:
      "Claim the next item and start it — the pull equivalent of the OpenCode plugin's /agentic-loop:engineering watch. Polls all enabled loop kinds in claim-priority order; pass `kind` to restrict the pull to one kind (e.g. /agentic-loop:engineering claim pr-sitter). For engineering it claims build-ready in-progress/ work only (lowest priority number first) — planless queued/ tasks are never auto-planned; plan them with loop_start({id}). Returns null when nothing is claimable.",
    inputSchema: { kind: z.string().optional().describe("Restrict the pull to one enabled loop kind (e.g. pr-sitter).") },
  },
  async ({ kind }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    if (kind && !enabledLoopKinds(config).includes(kind)) {
      return fail(`Unknown loop kind "${kind}" — enabled: ${enabledLoopKinds(config).join(", ")}.`)
    }
    const { claim, skips } = await pollOnce(sourcesFor(kind))
    if (!claim) {
      return ok(skips.length ? { claimed: null, skips } : null)
    }
    activeClaim = claim
    let state = claim.item.state
    samples = []
    pending = null
    verdictRetried = false
    const loaded = manifestFor(claim.item.loopKind)
    if (stageDef(loaded.manifest, state.stage).isolation !== "none") {
      // Task-backed claims get the durable CLAIMED note on the human branch
      // before feature/<id> is cut — same as startTask (see store.ts CLAIMED_MARKER).
      if (state.task) {
        await markClaimed(sh, state.task, await gitActor(sh, directory), log)
        await commitPaths(sh, directory, [config.tasksDir], `loop(${state.task.id}): claimed`)
      }
      try {
        state = await ensureIsolation(sh, log, directory, config, state, await resolveBase())
      } catch (err) {
        await claim.source.release(claim.item)
        activeClaim = null
        return fail((err as Error).message)
      }
      active = state
      await snapshot()
    } else {
      active = state
      // Arm the stage marker for a no-isolation entry stage, mirroring startPlan
      // (loop_start's queued path). Engineering's PLAN is spawned straight off this
      // claim with no loop_stage call (firePayload emits no such instruction for
      // plan), so without the marker the {stage:"plan", taskId} carve-out never
      // exists and the plan-author's one write to queued/<id>.md is blocked (exit 2)
      // → loop_advance finds no plan. Sitter check-stage entries re-arm via loop_stage
      // anyway, so this is the fix for PLAN and a harmless no-op for them.
      writeStageMarker(state.stage)
    }
    const warnings = await claimWarnings()
    return ok({ ...firePayload(state, claim.item.id), ...(warnings.length ? { warnings } : {}) })
  },
)

server.registerTool(
  "loop_compose",
  {
    description: "Return the composed prompt (goal + relevant prior artifacts + isolation lines) to hand a stage subagent.",
    inputSchema: { stage: z.string().min(1) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    try {
      return ok({ prompt: composePrompt(activeManifest(), active, stage) })
    } catch (err) {
      return fail((err as Error).message)
    }
  },
)

server.registerTool(
  "loop_verdict",
  {
    description:
      "Record the VERIFY or REVIEW verdict for the running loop. THE ONLY TRUSTED verdict channel — a PASS/FAIL in prose is ignored. Called by the loop-verify/loop-review subagent exactly once per pass. Multiple calls in one stage (multi-lens review) are combined worst-wins.",
    inputSchema: {
      stage: z.string().min(1).describe("The loop's currently running check stage (engineering: verify/review; pr-sitter: triage/verify)."),
      verdict: z.enum(["PASS", "FAIL", "ERROR"]),
      reason: z.string().max(500).optional(),
      criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean() })).optional(),
    },
  },
  async ({ stage, verdict, reason, criteria }) => {
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
    if (activeManifest().manifest.stages.find((d) => d.name === stage)?.kind !== "check") {
      return fail(`Stage ${stage} is not a check stage — verdict ignored.`)
    }
    const rec: VerdictRecord = { verdict, ...(reason ? { reason } : {}), ...(criteria ? { criteria: criteria as CriterionResult[] } : {}) }
    if (!pending) pending = rec
    else {
      const combined = worstOf([pending.verdict, rec.verdict])
      const reasons = [pending.reason, rec.reason].filter(Boolean)
      const crit = [...(pending.criteria ?? []), ...(rec.criteria ?? [])]
      pending = { verdict: combined, ...(reasons.length ? { reason: reasons.join(" · ") } : {}), ...(crit.length ? { criteria: crit } : {}) }
    }
    stampVerdictRecorded()
    return ok({ recorded: pending.verdict })
  },
)

server.registerTool(
  "loop_isolate",
  {
    description:
      "Explicitly ensure the feature/<id> branch (or worktree when worktreesDir is set) exists. Normally loop_start does this; use it standalone only when recovering.",
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
  "loop_stage",
  {
    description:
      "Set the current stage marker so the PreToolUse hook enforces the right bash allowlist (default-deny for verify/review) and the stage deadline. Call right before spawning EACH stage subagent, plan and build included. The stage must be the one the state machine is at (the stage the last fire action named) — a mismatch means loop_advance was skipped and the call is rejected. Setting 'build' appends the audited 'BUILD started' note the claimability predicates key on.",
    inputSchema: { stage: z.string().min(1) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    if (!activeManifest().manifest.stages.some((d) => d.name === stage)) {
      return fail(`Unknown stage "${stage}" for loop kind "${activeManifest().manifest.kind}".`)
    }
    const outOfOrder = stageOrderError(active.stage, stage)
    if (outOfOrder) return fail(outOfOrder)
    if (stageDef(activeManifest().manifest, stage).isolation !== "none") {
      // A no-isolation stage (engineering's PLAN) runs in the main tree — no branch, no worktree to reconcile.
      try {
        active = await ensureIsolation(sh, log, directory, config, active, await resolveBase()) // reconcile a moved/vanished worktree
      } catch (err) {
        return fail((err as Error).message)
      }
    }
    writeStageMarker(stage)
    lastFireAt = Date.now()
    pending = null // no stale verdict may leak into this stage
    if (stage === "build" && active.task) {
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
    const def = stageDef(activeManifest().manifest, stage)
    const model = stageModel(activeManifest().manifest.kind, def)
    return ok({
      stage,
      agent: agentRef(def.agent),
      ...(model ? { model } : {}),
      worktree: active.git?.worktree ?? null,
      ...(active.isolationWarning ? { isolationWarning: active.isolationWarning } : {}),
      deadlineMinutes: config.stageTimeoutMinutes,
      ...(def.kind === "check"
        ? {
            note:
              "check stage: the spawned subagent MUST call the loop_verdict MCP tool before returning — " +
              "a verdict in prose is ignored. Never call loop_verdict yourself on its behalf.",
          }
        : {}),
    })
  },
)

server.registerTool(
  "loop_advance",
  {
    description:
      "Feed a completed stage's output back into the state machine and get the next action. Returns {kind:'fire',stage,prompt} to run the next stage, or {kind:'done'|'stop'} (terminal — the task is moved and metrics written). Uses the verdict recorded via loop_verdict for check stages. A stage past its stageTimeoutMinutes deadline stops the loop.",
    inputSchema: { stageOutput: z.string().describe("The finished stage subagent's summary/output text.") },
  },
  async ({ stageOutput }) => {
    if (!active) return fail("No active loop.")
    const stage = active.stage
    if (isOverdue(stageDeadline, Date.now())) {
      const action: Action = {
        kind: "stop",
        message: `✗ Loop stopped — ${stage} exceeded stageTimeoutMinutes (${config.stageTimeoutMinutes}m). Fix what hung it, then /agentic-loop:engineering recover the task.`,
      }
      samples.push({ stage, iteration: active.iteration, ms: Date.now() - lastFireAt, startedAt: new Date(lastFireAt).toISOString() })
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
      ...(stageDef(activeManifest().manifest, stage).kind === "check" ? { verdict: (pending?.verdict ?? "none") as Verdict | "none" } : {}),
    })
    flushRunMetrics(loopId(active)) // publish samples-so-far live to the hub
    // A check stage that ended with NO loop_verdict call is a broken verdict
    // channel, not a genuine FAIL — re-fire the same check once (no iteration
    // consumed, no rebuild), then stop with a retryable ERROR instead of
    // burning build iterations on a stage that may have passed (the
    // theater-booking-0 failure mode: three rebuilds of an already-done task).
    if (stageDef(activeManifest().manifest, stage).kind === "check" && !pending) {
      // Diagnostic only — free text never flips control flow (verdict.ts).
      const prose = parseVerdict(stageOutput, `LOOP_${stage.toUpperCase()}`)
      if (!verdictRetried) {
        verdictRetried = true
        if (active.task) {
          const noteActor = await gitActor(sh, directory)
          await appendNote(
            sh,
            active.task,
            auditNote(
              `${stage.toUpperCase()} ended with no loop_verdict call — re-running the check once (prose claimed ${prose ?? "nothing"}; free text is untrusted)`,
              new Date(),
              noteActor,
            ),
            log,
          )
        }
        writeStageMarker(stage) // fresh deadline + verdictRecorded:false for the re-fire
        lastFireAt = Date.now()
        const retryModel = stageModel(activeManifest().manifest.kind, stageDef(activeManifest().manifest, stage))
        return ok({
          action: { kind: "fire", stage },
          agent: agentRef(stageDef(activeManifest().manifest, stage).agent),
          ...(retryModel ? { model: retryModel } : {}),
          prompt:
            composePrompt(activeManifest(), active, stage) +
            "\n\nPREVIOUS ATTEMPT RECORDED NO VERDICT — the loop_verdict tool call is MANDATORY. " +
            "If the tool is not in your tool list, state that explicitly in your final message and finish.",
          note: "check retry (no iteration consumed): the previous pass never called loop_verdict — call loop_stage, then spawn the stage subagent again",
        })
      }
      pending = {
        verdict: "ERROR",
        reason:
          "no loop_verdict recorded even after a retry — the verdict channel is unreachable from the stage subagent " +
          "or the agent contract was not applied; fix the plugin wiring, then recover the task" +
          (prose ? ` (prose claimed ${prose}, ignored — free text is untrusted)` : ""),
      }
    }
    // thread failed criteria ahead of the prose for the next iteration
    const block = failedCriteriaBlock(pending)
    const threaded = block ? `${block}\n\n${stageOutput}` : stageOutput
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      await commitAll(
        sh,
        workTree(),
        `loop(${loopId(active)}): build checkpoint (iteration ${active.iteration + 1})`,
        active.git?.worktree ? [config.tasksDir] : undefined,
      )
    }
    if (stageDef(activeManifest().manifest, stage).kind === "check" && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending?.verdict ?? "none → FAIL"}${failed ? ` (${failed} criteria unmet)` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    const verdict = stageDef(activeManifest().manifest, stage).kind === "check" ? (pending?.verdict ?? null) : null
    const { state, action } = advance(activeManifest(), active, config, threaded, verdict)
    active = state
    pending = null
    verdictRetried = false // the transition happened — the next check stage gets its own retry budget

    if (action.kind === "fire") {
      await snapshot()
      const nextDef = stageDef(activeManifest().manifest, action.stage)
      const nextModel = stageModel(activeManifest().manifest.kind, nextDef)
      return ok({
        action: { kind: "fire", stage: action.stage },
        agent: agentRef(nextDef.agent),
        ...(nextModel ? { model: nextModel } : {}),
        prompt: composePrompt(activeManifest(), active, action.stage),
        note:
          "call loop_stage, then spawn the subagent named in the `agent` field" +
          (nextDef.kind === "check"
            ? " — it MUST call the loop_verdict MCP tool before returning; never call loop_verdict yourself on its behalf"
            : ""),
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
    await runTerminal(action)
    return ok({
      action: { kind: action.kind, message: (action as { message: string }).message },
      ...(action.kind === "done" && taskId
        ? {
            taskId,
            gate: { kind: "ship", id: taskId },
            next:
              `ship gate: show the user the loop branch's diff summary, then ask with AskUserQuestion — ` +
              `Ship (loop_ship("${taskId}")), Replan with a reason (loop_replan("${taskId}", reason)), ` +
              `or Leave in in-review (stop here; /agentic-loop:engineering approve ${taskId} ships it later).`,
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
      `Approve (loop_plan_approve("${id}") then loop_start("${id}") continues into BUILD now), ` +
      `Replan with a reason (loop_replan("${id}", reason)), ` +
      `or Park for later (stop here; /agentic-loop:engineering approve ${id} resumes it).`,
  }
}

server.registerTool(
  "loop_stop",
  {
    description: "Abort the active loop: checkpoint partial work, append an audited stop note, write the run summary, clear the snapshot, and tear down isolation. The loop branch keeps the committed work.",
    inputSchema: {},
  },
  async () => {
    if (!active) return ok({ stopped: false, note: "no active loop" })
    const action: Action = {
      kind: "stop",
      message: `Loop stopped by /agentic-loop:engineering stop at ${active.stage} (iteration ${active.iteration + 1}).`,
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
const runTerminal = async (action: Action) => {
  if (!active || (action.kind !== "done" && action.kind !== "stop")) return
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
    activeClaim = null
  }
  active = null
}

server.registerTool(
  "loop_checkpoint",
  { description: "Commit the current build state as a checkpoint on the loop branch/worktree.", inputSchema: { message: z.string() } },
  async ({ message }) => {
    if (!active?.git) return ok({ committed: false, note: "no isolation active" })
    const done = await commitAll(sh, workTree(), message, active.git.worktree ? [config.tasksDir] : undefined)
    return ok({ committed: done })
  },
)

server.registerTool(
  "loop_note",
  { description: "Append a timestamped, secret-redacted audit note to the active loop's task file.", inputSchema: { text: z.string() } },
  async ({ text }) => {
    if (!active?.task) return fail("No active task-backed loop.")
    await appendNote(sh, active.task, auditNote(text, new Date(), await gitActor(sh, directory)), log)
    return ok({ noted: true })
  },
)

/** The loop kinds this repo ships (loops/<kind>/ dirs) with their enabled state. */
const kindsReport = (): { kind: string; enabled: boolean }[] => {
  const enabled = enabledLoopKinds(config)
  let known: string[]
  try {
    known = fs
      .readdirSync(LOOPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    known = enabled
  }
  return known.map((kind) => ({ kind, enabled: enabled.includes(kind) }))
}

server.registerTool(
  "loop_status",
  {
    description:
      "Report the active loop (stage/iteration) plus a whole-backlog roll-up: counts per folder, the actionable flags, and the loop kinds (enabled/disabled).",
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
      ...(hasAnomalies(anomalies) ? { anomalies: formatAnomalies(anomalies, config.tasksDir).map((l) => `${l} (loop_doctor repairs)`) } : {}),
    })
  },
)

server.registerTool(
  "loop_doctor",
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
      ...(anomalies.duplicates.length ? { note: "duplicates are never auto-fixed — keep one copy, loop_move the rest to abandoned" } : {}),
    }
    if (!fix) return ok({ ...report, next: hasAnomalies(anomalies) || Object.keys(heldClaims).length ? "loop_doctor with fix:true applies the unambiguous repairs" : "backlog is clean" })

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
        ...(status === "queued" ? { isOrphaned: isOrphanedPlanClaim } : {}),
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
 * @agentic-loop/core/loop/gate, shared with the OpenCode driver. These thin
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

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
server.registerTool(
  "loop_task_approve",
  {
    description:
      "Deterministic /agentic-loop:engineering approve <id> on a draft — the task gate: move a reviewed draft/ task to queued/ (audited note + commit). No plan is required or expected; the loop's PLAN stage writes it right before execution. The agent writes nothing. Prefer loop_approve (the unified gate) unless you specifically need the draft-only form.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approveTask(id)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "loop_plan_approve",
  {
    description:
      "Deterministic /agentic-loop:engineering approve <id> — the plan gate: validate the plan-review/ task has an ## Implementation Plan, move it to in-progress/ (the build-ready queue), append an audited note, and commit. Refuses planless tasks. The agent writes nothing. Prefer loop_approve (the unified gate).",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approvePlan(id)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "loop_replan",
  {
    description:
      "Deterministic /agentic-loop:engineering replan <id> [reason] — the sole rejection verb: reject a parked plan (plan-review/) or send a cap-tripped in-progress/ task back to queued/ with an audited note, so the next PLAN pass addresses why the old plan failed. Refuses tasks a live loop is driving.",
    inputSchema: { id: z.string().min(1), reason: z.string().max(500).optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    const r = await replanTask(id, reason, active?.task?.id ?? null)
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "loop_approve",
  {
    description:
      "/agentic-loop:engineering approve [id] — the unified, folder-driven gate. With an explicit id it advances that task by its folder's gate: draft/ → queued (task gate), plan-review/ → in-progress (plan gate, requires an ## Implementation Plan), or in-review/ → completed (ship). The id is OPTIONAL — omit it to advance the single task at a loop wait-gate (plan-review/ or in-review/; drafts always need the explicit id). Prefer this over the specific loop_task_approve / loop_plan_approve / loop_ship tools. The agent writes nothing.",
    inputSchema: { id: z.string().optional() },
  },
  async ({ id }) => {
    await loadCfg()
    const r = await approveAny((id ?? "").trim())
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "loop_reject",
  {
    description:
      "/agentic-loop:engineering replan [id] [reason] — the folder-driven rejection shortcut. Sends a parked plan back to queued/ for re-planning (the counterpart of loop_approve at the plan gate). Auto-targets the single plan-review/ task when no id is given; an explicit id may also name a cap-tripped in-progress/ task. The reason is recorded in the audit note. Refuses a task a live loop is driving.",
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
  "loop_move",
  { description: "Move a task file to another status folder.", inputSchema: { id: z.string(), status: z.enum(["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"]) } },
  async ({ id, status }) => {
    await loadCfg()
    const found = await findAnyStatus(id)
    if (!found) return fail(`No task "${id}".`)
    const newPath = await moveTask(sh, { id, path: found.path }, status)
    return ok({ moved: newPath })
  },
)

server.registerTool(
  "loop_ship",
  { description: "Ship a reviewed task: move it in-review/ → completed/ with an audited note and commit. The final human gate action. The id is OPTIONAL — omit it to ship the single in-review/ task; pass it only to disambiguate. /agentic-loop:engineering approve (loop_approve) does the same when the only awaiting task is in in-review/.", inputSchema: { id: z.string().optional() } },
  async ({ id }) => {
    await loadCfg()
    const r = await shipAny((id ?? "").trim())
    return r.ok ? ok(r.data) : fail(r.message)
  },
)

server.registerTool(
  "loop_recover",
  {
    description:
      "Resume an interrupted in-progress task from its state snapshot (exact stage) or, failing that, from its persisted plan at BUILD. Refuses never-started tasks (use loop_start/loop_claim) and planless ones (re-plan first). Returns the next action + prompt.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    // Accept the short-hash handle, same as loop_start and the gate tools.
    const resolved = await resolveTaskIdAnywhere(sh, directory, config.tasksDir, id, log)
    if (resolved && "ambiguous" in resolved) {
      return fail(`Ambiguous id "${id}" — matches ${resolved.ambiguous.join(", ")}. Use more characters.`)
    }
    if (resolved) id = resolved.id
    const t = await findByIdIn(sh, directory, config.tasksDir, "in-progress", id)
    if (!t) return fail(`No in-progress task "${id}".`)
    if (isClaimable(t)) return fail(`Task "${id}" never started — start it with loop_start or loop_claim.`)
    if (!isRecoverable(t)) return fail(`Task "${id}" has no Implementation Plan — send it back to planning with loop_replan.`)
    await claimTask(sh, t) // re-mark; the dead run's claim marker may linger
    const snap = await loadState(fsClient, directory, config.tasksDir, id)
    samples = []
    pending = null
    verdictRetried = false
    const actor = await gitActor(sh, directory)
    if (snap && snap.task?.id === id) {
      active = { ...snap, task: { ...snap.task, path: t.path } }
      try {
        active = await ensureIsolation(sh, log, directory, config, active, await resolveBase())
      } catch (err) {
        active = null
        return fail((err as Error).message)
      }
      await appendNote(sh, active.task as TaskRef, auditNote(`Recovered from snapshot at ${active.stage}`, new Date(), actor), log)
      const step = firstStep(eng, active)
      return ok({ resumedFrom: "snapshot", stage: active.stage, action: step.action, note: "call loop_stage before spawning the subagent" })
    }
    active = buildEntryState(t)
    try {
      active = await ensureIsolation(sh, log, directory, config, active, await resolveBase())
    } catch (err) {
      active = null
      return fail((err as Error).message)
    }
    await appendNote(sh, active.task as TaskRef, auditNote("Recovered from persisted plan — re-entering at BUILD", new Date(), actor), log)
    await snapshot()
    return ok({ resumedFrom: "plan", stage: "build", prompt: composePrompt(eng, active, "build"), note: "call loop_stage before spawning the subagent" })
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
    const raw = fs.readFileSync(path.join(directory, config.tasksDir, "runs", ".stage.json"), "utf8")
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
    emit({ ok: false, message: "Usage: gate <approve-any|reject-any|approve|approve-plan|replan> [id] [reason]" })
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
      emit({ ok: false, message: "Usage: gate <approve|approve-plan|replan> <id> [reason]" })
      return 1
    }
    if (verb === "approve") result = await approveTask(id)
    else if (verb === "approve-plan") result = await approvePlan(id)
    else if (verb === "replan") result = await replanTask(id, reason, readStageTaskId())
    else result = { ok: false, message: `Unknown gate verb "${verb}" — expected approve-any, reject-any, approve, approve-plan, or replan.` }
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
      else await log("info", `leftover loop worktree: ${w.path} (${w.branch}) — no in-progress/in-review task ${id}; /agentic-loop:engineering recover its task or remove it`)
    }
  }
  await log("info", `agentic-loop MCP server ready (directory=${directory})`)
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
    process.stderr.write(`agentic-loop MCP fatal: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
