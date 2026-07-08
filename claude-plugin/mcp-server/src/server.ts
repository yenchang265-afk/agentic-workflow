#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { DEFAULT_CONFIG, loadConfig } from "@agentic-loop/core/config"
import {
  resumeAtBuild,
  startAtPlan,
  type Action,
  type Config,
  type LoopState,
  type TaskRef,
} from "@agentic-loop/core/loop/state"
import { advance, composePrompt, firstStep } from "@agentic-loop/core/loop/engine"
import { registerEngineeringHooks } from "@agentic-loop/core/kinds/engineering"
import { loadManifest } from "@agentic-loop/core/manifest/load"
import { effectiveAllowlist, stageDef, type LoadedManifest } from "@agentic-loop/core/manifest/schema"
import { pollOnce } from "@agentic-loop/core/scheduler/scheduler"
import { makeAdoPrSource } from "@agentic-loop/core/source/ado-pr"
import {
  makeAdoMcpPrSource,
  AdoDataBundleSchema,
  describeAdoDataRequest,
  type AdoDataBundle,
  type AdoDataRequest,
} from "@agentic-loop/core/source/ado-mcp-pr"
import { makeBacklogSource } from "@agentic-loop/core/source/backlog"
import { makeGithubPrSource } from "@agentic-loop/core/source/github-pr"
import type { PolledClaim } from "@agentic-loop/core/scheduler/scheduler"
import type { ClaimSkipReason, WorkSource } from "@agentic-loop/core/source/types"
import { enabledLoopKinds, platformFor } from "@agentic-loop/core/config"
import { fileURLToPath } from "node:url"
import { failedCriteriaBlock, worstOf, type CriterionResult, type Verdict, type VerdictRecord } from "@agentic-loop/core/loop/verdict"
import { renderRunSummary, type Outcome, type StageSample } from "@agentic-loop/core/loop/metrics"
import { commitAll, commitPaths, currentBranch, gitActor, listWorktrees, pruneWorktrees } from "@agentic-loop/core/loop/git"
import { ensureIsolation, loopId, teardownIsolation } from "@agentic-loop/core/loop/isolate"
import { clearState, loadState, saveState } from "@agentic-loop/core/loop/persist"
import { type Task } from "@agentic-loop/core/task/schema"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimTask,
  extractPlan,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedPlanClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  moveTask,
  pairingCoverage,
  releaseClaim,
  releaseOrphanedClaims,
  rescueStray,
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
 * Task authoring happens before the loop, in `/agent-loop-task`: `new` interviews
 * the user into a draft (main-agent turn) and `loop_task_approve` parks it
 * planless in `queued/`. Planning happens inside the loop, right before
 * execution: `loop_start`/`loop_claim` on a queued task enter at PLAN (no git
 * isolation — it writes only the task file), and `loop_advance` after PLAN
 * parks the task in `plan-review/` and ends the loop (`park`). The human plan
 * gate is `loop_plan_approve` (plan-review → in-progress); `loop_replan`
 * sends a rejected or cap-tripped task back to `queued/`. From `in-progress/`
 * — the build-ready queue — claims enter at BUILD.
 *
 * There is no `/agent-loop watch` here, deliberately: watch needs an autonomous
 * driver firing stages on idle events/timers, and the MCP server can't spawn
 * subagents. `loop_claim` is the pull equivalent — one human trigger claims
 * the next approved task.
 */

const directory = process.env.AGENTIC_LOOP_DIR ?? process.cwd()
/**
 * Where to read the base branch for a fresh `loop/<id>` worktree. `directory`
 * (the canonical root: backlog + worktree parent) is frozen at server launch
 * on the main checkout — usually the default branch — so worktrees would
 * always cut from it. Point `AGENTIC_LOOP_BASE_DIR` at the tree you actually
 * work in and the base is read there live (per claim). Unset ⇒ core falls back
 * to `directory`'s branch (today's behavior).
 */
const baseDir = process.env.AGENTIC_LOOP_BASE_DIR
const resolveBase = async (): Promise<string | undefined> =>
  baseDir ? ((await currentBranch(sh, baseDir)) ?? undefined) : undefined
/** The loop-kind manifests shipped with this repo (loops/<kind>/) — resolved
 *  relative to this module so the server works from any cwd. */
const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "loops")
const eng = loadManifest(LOOPS_DIR, "engineering")
registerEngineeringHooks()

/** Loaded manifests by kind — engineering eagerly, other enabled kinds on first poll. */
const manifests = new Map<string, LoadedManifest>([["engineering", eng]])
const manifestFor = (kind: string): LoadedManifest => {
  let loaded = manifests.get(kind)
  if (!loaded) {
    loaded = loadManifest(LOOPS_DIR, kind)
    manifests.set(kind, loaded)
  }
  return loaded
}
const log = (level: "info" | "warn" | "error", message: string) =>
  fsClient.app.log({ body: { service: "agentic-loop", level, message } })

// --- shared in-process loop state (one active loop per server/session) ---

let active: LoopState | null = null
let activeClaim: PolledClaim | null = null // the scheduler claim behind `active`, when loop_claim made it
let pending: VerdictRecord | null = null // verdict(s) recorded for the current check stage
let samples: StageSample[] = [] // per-run metrics
let lastFireAt = Date.now()
let stageDeadline: number | null = null // wall-clock cap for the stage in flight
let config: Config = DEFAULT_CONFIG
// ADO data an agent gathered for the current loop_claim, set by the caller and
// consumed by the ado-mcp source's provider within one poll (see loop_claim).
let pendingAdoBundle: AdoDataBundle | null = null

const loadCfg = async () => {
  try {
    config = await loadConfig(fsClient, directory)
  } catch (err) {
    await log("warn", `using default config: ${(err as Error).message}`)
    config = DEFAULT_CONFIG
  }
}

// --- helpers ported from driver.ts ---

const taskGoal = (t: Task): string => (t.body ? `${t.title}\n\n${t.body}` : t.title)
const taskRef = (t: Task, p: string): TaskRef => ({
  id: t.id,
  path: p,
  acceptance: t.acceptance,
})
const stageMarkerPath = () => path.join(directory, config.tasksDir, "runs", ".stage.json")

/** Write the current-stage marker the PreToolUse hook reads to scope the
 *  allowlist and enforce the stage deadline. */
const writeStageMarker = (stage: string | null) => {
  const dir = path.join(directory, config.tasksDir, "runs")
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (stage === null) {
      stageDeadline = null
      fs.rmSync(stageMarkerPath(), { force: true })
    } else {
      const m = activeManifest()
      const def = stageDef(m.manifest, stage)
      stageDeadline = Date.now() + (def.timeoutMinutes ?? config.stageTimeoutMinutes) * 60_000
      fs.writeFileSync(
        stageMarkerPath(),
        JSON.stringify({
          kind: m.manifest.kind,
          stage,
          // The backlog guard's PLAN carve-out: only this task's queued/ file
          // may be written directly while PLAN is live.
          taskId: active?.task?.id ?? null,
          worktree: active?.git?.worktree ?? null,
          deadline: stageDeadline,
          // The platform stamped into the state at claim time wins over the
          // live config: prompt guidance renders from the same stamp, and a
          // config flip mid-loop must not strand a claimed PR with an
          // allowlist that contradicts its prompt.
          ...(def.kind === "check"
            ? { bashAllowlist: effectiveAllowlist(def, active?.platform ?? platformFor(config, m.manifest.kind)) }
            : {}),
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

const workTree = () => active?.git?.worktree ?? directory

/** The manifest driving the active loop (engineering when kind is absent). */
const activeManifest = (): LoadedManifest => manifestFor(active?.kind ?? "engineering")

/** Serialize a value into an MCP text result. */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] })

/** Locate which status folder a task id lives in. */
const findAnyStatus = async (id: string): Promise<Task | null> => {
  for (const s of STATUSES) {
    const t = await findByIdIn(sh, directory, config.tasksDir, s, id)
    if (t) return t
  }
  return null
}

/** The work sources loop_claim polls, in claim-priority order (config order). */
const sourcesFor = (): WorkSource[] =>
  enabledLoopKinds(config).flatMap((kind): WorkSource[] => {
    const loaded = manifestFor(kind)
    if (loaded.manifest.workSource.type === "github-pr") {
      const platform = platformFor(config, kind)
      if (platform === "ado") {
        return [
          makeAdoPrSource({
            $: sh,
            client: fsClient,
            directory,
            tasksDir: config.tasksDir,
            log,
            loaded,
            // Config parse fails fast when platform "ado" lacks the ado section.
            ado: config.ado!,
          }),
        ]
      }
      if (platform === "ado-mcp") {
        return [
          makeAdoMcpPrSource({
            $: sh,
            client: fsClient,
            directory,
            tasksDir: config.tasksDir,
            log,
            loaded,
            ado: config.ado!,
            // The main agent pre-fetches ADO data and hands it to loop_claim; the
            // provider serves that bundle within the same poll, else signals
            // "needs data" so loop_claim can ask the agent to gather it.
            provider: { fetch: async () => pendingAdoBundle },
          }),
        ]
      }
      const query = config.loops[kind]?.["query"]
      return [
        makeGithubPrSource({
          $: sh,
          client: fsClient,
          directory,
          tasksDir: config.tasksDir,
          log,
          loaded,
          ...(typeof query === "string" ? { query } : {}),
        }),
      ]
    }
    return [
      makeBacklogSource({
        $: sh,
        client: fsClient,
        directory,
        tasksDir: config.tasksDir,
        log,
        loaded,
        // Single active loop per server; a claim only happens when no loop is live.
        isDriving: (id) => active?.task?.id === id,
      }),
    ]
  })

/** Claim an approved in-progress task and construct its build-entry state.
 *  Shared by loop_start and loop_claim. */
const startTask = async (t: Task): Promise<{ error: string } | { state: LoopState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  let state = resumeAtBuild(taskGoal(t), taskRef(t, t.path), extractPlan(t) ?? "")
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
 *  tree, and a died PLAN is recovered by re-claiming from queued/. */
const startPlan = async (t: Task): Promise<{ error: string } | { state: LoopState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  const state = startAtPlan(taskGoal(t), taskRef(t, t.path), extractPlan(t))
  active = state
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
const firePayload = (state: LoopState, id: string) => ({
  action: { kind: "fire", stage: state.stage },
  taskId: id,
  isolation: state.git ?? null,
  prompt: composePrompt(manifestFor(state.kind ?? "engineering"), state, state.stage),
  ...(state.stage === "plan"
    ? { note: "PLAN stage: spawn loop-plan-author in task mode; on loop_advance the task parks in plan-review/ for the human gate" }
    : {}),
})

// --- server + tools ---

const server = new McpServer({ name: "agentic-loop", version: "0.0.1" })

server.registerTool(
  "loop_start",
  {
    description:
      "Execute one task now. An in-progress/ task (plan approved via loop_plan_approve) is claimed and started at BUILD with git isolation; a queued/ task (approved via loop_task_approve, planless) is claimed and started at PLAN — it will park in plan-review/ for the human plan gate. Returns the composed stage prompt. Call loop_stage right before spawning the stage subagent.",
    inputSchema: { id: z.string().min(1).describe("The task's id (filename without .md) in in-progress/ or queued/.") },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
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
      "Claim the next task and start it — the pull equivalent of the OpenCode plugin's /agent-loop watch. Build-ready in-progress/ tasks win over planless queued/ ones (finish work in flight before planning new work); within each pool, lowest priority number first. Returns null when both pools are empty. Azure DevOps MCP mode (codePlatform 'ado-mcp'): a first call may return {claimed:null, needsAdoData:{request, guidance}} — spawn the loop-pr-poll agent with `guidance`, then call loop_claim again passing its JSON as `adoData`.",
    inputSchema: {
      adoData: z
        .unknown()
        .optional()
        .describe("For codePlatform 'ado-mcp': the JSON bundle the loop-pr-poll agent returned, from a prior needsAdoData response."),
    },
  },
  async ({ adoData }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    if (adoData !== undefined) {
      const parsed = AdoDataBundleSchema.safeParse(adoData)
      if (!parsed.success) return fail(`adoData did not match the expected bundle shape: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`)
      pendingAdoBundle = parsed.data
    }
    let claim: PolledClaim | null
    let skips: readonly ClaimSkipReason[]
    try {
      ;({ claim, skips } = await pollOnce(sourcesFor()))
    } finally {
      pendingAdoBundle = null // a bundle is valid for exactly one poll
    }
    if (!claim) {
      // In ado-mcp mode a source may need ADO data gathered by an agent first.
      const needs = skips.find((s) => s.needsAdoData && s.request)
      if (needs) {
        const request = needs.request as AdoDataRequest
        return ok({
          claimed: null,
          needsAdoData: { request, guidance: describeAdoDataRequest(request) },
          note: "Spawn the loop-pr-poll agent with `guidance`, then call loop_claim again passing its JSON as `adoData`.",
        })
      }
      return ok(skips.length ? { claimed: null, skips } : null)
    }
    activeClaim = claim
    let state = claim.item.state
    samples = []
    pending = null
    const loaded = manifestFor(claim.item.loopKind)
    if (stageDef(loaded.manifest, state.stage).isolation !== "none") {
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
    if (active.stage !== stage) return fail(`The loop is at ${active.stage}, not ${stage} — verdict ignored.`)
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
    return ok({ recorded: pending.verdict })
  },
)

server.registerTool(
  "loop_isolate",
  {
    description:
      "Explicitly ensure the loop/<id> branch (or worktree when worktreesDir is set) exists. Normally loop_start does this; use it standalone only when recovering.",
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
    return ok({ isolated: Boolean(active.git), git: active.git ?? null })
  },
)

server.registerTool(
  "loop_stage",
  {
    description:
      "Set the current stage marker so the PreToolUse hook enforces the right bash allowlist (default-deny for verify/review) and the stage deadline. Call right before spawning EACH stage subagent, plan and build included. Setting 'build' appends the audited 'BUILD started' note the claimability predicates key on.",
    inputSchema: { stage: z.string().min(1) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    if (!activeManifest().manifest.stages.some((d) => d.name === stage)) {
      return fail(`Unknown stage "${stage}" for loop kind "${activeManifest().manifest.kind}".`)
    }
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
    }
    return ok({ stage, worktree: active.git?.worktree ?? null, deadlineMinutes: config.stageTimeoutMinutes })
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
        message: `✗ Loop stopped — ${stage} exceeded stageTimeoutMinutes (${config.stageTimeoutMinutes}m). Fix what hung it, then /agent-loop recover the task.`,
      }
      samples.push({ stage, iteration: active.iteration, ms: Date.now() - lastFireAt })
      await runTerminal(action)
      return ok({ action })
    }
    // record a metrics sample for the stage that just finished
    samples.push({
      stage,
      iteration: active.iteration,
      ms: Date.now() - lastFireAt,
      ...(stageDef(activeManifest().manifest, stage).kind === "check" ? { verdict: (pending?.verdict ?? "none") as Verdict | "none" } : {}),
    })
    // thread failed criteria ahead of the prose for the next iteration
    const block = failedCriteriaBlock(pending)
    const threaded = block ? `${block}\n\n${stageOutput}` : stageOutput
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      await commitAll(sh, workTree(), `loop(${loopId(active)}): build checkpoint (iteration ${active.iteration + 1})`)
    }
    if (stageDef(activeManifest().manifest, stage).kind === "check" && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending?.verdict ?? "none → FAIL"}${failed ? ` (${failed} criteria unmet)` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    const verdict = stageDef(activeManifest().manifest, stage).kind === "check" ? (pending?.verdict ?? null) : null
    const { state, action } = advance(activeManifest(), active, config, threaded, verdict)
    active = state
    pending = null

    if (action.kind === "fire") {
      await snapshot()
      return ok({
        action: { kind: "fire", stage: action.stage },
        prompt: composePrompt(activeManifest(), active, action.stage),
        note: "call loop_stage before spawning the subagent",
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
              `or Leave in in-review (stop here; /agent-loop ship ${taskId} ships it later).`,
          }
        : {}),
    })
  },
)

/** Terminal bookkeeping for the PLAN stage's park: validate, move, commit, clear. */
const runPark = async (
  action: Extract<Action, { kind: "park" }>,
): Promise<
  | { error: string }
  | { action: { kind: "park"; message: string }; path: string; gate: { kind: "plan"; id: string }; next: string }
> => {
  if (!active?.task) {
    activeClaim = null
    active = null
    writeStageMarker(null)
    return { error: "No task-backed loop to park." }
  }
  const id = active.task.id
  const fresh = await findByIdIn(sh, directory, config.tasksDir, "queued", id)
  const actor = await gitActor(sh, directory)
  if (!fresh || !hasPlan(fresh)) {
    const why = fresh ? "the PLAN stage wrote no ## Implementation Plan" : "the task left queued/ mid-plan"
    if (fresh) {
      await appendNote(sh, fresh, auditNote(`PLAN stage failed — ${why}; still queued`, new Date(), actor), log)
      await releaseClaim(sh, fresh)
    }
    const summary = renderRunSummary(samples, "error", why, config.maxIterations, new Date().toISOString())
    await appendRunLog(sh, directory, config.tasksDir, id, "run · error", summary, log)
    activeClaim = null // the queued claim was already released above
    active = null
    writeStageMarker(null)
    return { error: `PLAN failed for "${id}" — ${why}. It stays in queued/.` }
  }
  await appendNote(sh, fresh, auditNote("Plan written — parked for plan review", new Date(), actor), log)
  const newPath = await moveTask(sh, fresh, (action.toStatus ?? "plan-review") as TaskStatus) // also releases the queued/ claim marker
  await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan written — parked for review`)
  const summary = renderRunSummary(samples, "done", "plan parked for review", config.maxIterations, new Date().toISOString())
  await appendRunLog(sh, directory, config.tasksDir, id, "run · done", summary, log)
  if (activeClaim) {
    await activeClaim.source.onTerminal?.(activeClaim.item, { kind: "park", message: action.message })
    activeClaim = null
  }
  active = null
  writeStageMarker(null)
  return {
    action: { kind: "park", message: action.message },
    path: newPath,
    gate: { kind: "plan", id },
    next:
      `plan gate: show the user the plan summary, then ask with AskUserQuestion — ` +
      `Approve (loop_plan_approve("${id}") then loop_start("${id}") continues into BUILD now), ` +
      `Replan with a reason (loop_replan("${id}", reason)), ` +
      `or Park for later (stop here; /agent-loop-task approve-plan ${id} resumes it).`,
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
      message: `Loop stopped by /agent-loop stop at ${active.stage} (iteration ${active.iteration + 1}).`,
    }
    await runTerminal(action)
    return ok({ stopped: true })
  },
)

/** Terminal bookkeeping for done/stop, mirroring the driver's switch. */
const runTerminal = async (action: Action) => {
  if (!active || (action.kind !== "done" && action.kind !== "stop")) return
  const actor = await gitActor(sh, directory)
  const outcome: Outcome = action.kind === "done" ? "done" : "stopped"
  const detail = action.kind === "done" ? "review passed" : (action as { message: string }).message
  // metrics summary into the run log
  const summary = renderRunSummary(samples, outcome, detail, config.maxIterations, new Date().toISOString())
  await appendRunLog(sh, directory, config.tasksDir, loopId(active), `run · ${outcome}`, summary, log)
  if (active.task) {
    if (action.kind === "done") {
      // Re-resolve the current path (shell-authoritative) — the claim-time
      // active.task.path goes stale if the file moved since the claim.
      const cur = await findByIdIn(sh, directory, config.tasksDir, "in-progress", active.task.id)
      if (cur) {
        await appendNote(sh, cur, auditNote("Loop done — review passed, awaiting human diff review", new Date(), actor), log)
        await moveTask(sh, cur, ((action as { toStatus?: string }).toStatus ?? "in-review") as TaskStatus)
      } else {
        log("warn", `loop done but task ${active.task.id} not in in-progress/ — not moved`)
      }
    } else {
      await appendNote(sh, active.task, auditNote((action as { message: string }).message, new Date(), actor), log)
      // A loop stopped mid-PLAN leaves the task in queued/ — release its claim
      // marker or no later claim can ever pick it up (there is no staleness
      // sweep on this substrate).
      if (active.stage === "plan") await releaseClaim(sh, active.task)
    }
    await commitPaths(sh, directory, [config.tasksDir], `loop(${active.task.id}): ${outcome}`)
  }
  if (active.git) await commitAll(sh, workTree(), `loop(${loopId(active)}): ${outcome}`)
  await teardownIsolation(sh, log, directory, active)
  if (active.task) await clearState(sh, directory, config.tasksDir, active.task.id)
  writeStageMarker(null)
  if (activeClaim) {
    const outcome = { kind: action.kind === "done" ? ("done" as const) : ("stop" as const), message: detail }
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
    const done = await commitAll(sh, workTree(), message)
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

server.registerTool(
  "loop_status",
  { description: "Report the active loop (stage/iteration) plus a whole-backlog roll-up: counts per folder and the actionable flags.", inputSchema: {} },
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
 * The three gate moves — approve, approve-plan, replan — extracted so the MCP
 * tools AND the deterministic `gate` CLI (invoked by the UserPromptSubmit hook)
 * run the exact same logic. Each assumes `loadCfg()` has already run and returns
 * a structured result: `data` feeds the MCP `ok(...)` envelope, `message` is the
 * human line the CLI prints / the hook surfaces to the user.
 */
type GateResult =
  | { ok: true; message: string; path: string; data: Record<string, unknown> }
  | { ok: false; message: string }

/** approve: a reviewed draft/ task → queued/ (audited note + commit). */
const approveTask = async (id: string): Promise<GateResult> => {
  const draft = await findByIdIn(sh, directory, config.tasksDir, "draft", id)
  if (!draft) {
    const elsewhere = await findAnyStatus(id)
    return {
      ok: false,
      message: elsewhere
        ? `Can't approve "${id}": it's in ${path.basename(path.dirname(elsewhere.path))} — only draft tasks can be approved.`
        : `Can't approve "${id}": no task found.`,
    }
  }
  const actor = await gitActor(sh, directory)
  await appendNote(sh, draft, auditNote("Task approved — queued for planning", new Date(), actor), log)
  const newPath = await moveTask(sh, draft, "queued")
  await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): task approved — queued for planning`)
  return {
    ok: true,
    message: `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/ for planning.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) runs its PLAN stage` },
  }
}

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
const approvePlan = async (id: string): Promise<GateResult> => {
  const task = await findByIdIn(sh, directory, config.tasksDir, "plan-review", id)
  if (!task) {
    const elsewhere = await findAnyStatus(id)
    const where = elsewhere ? path.basename(path.dirname(elsewhere.path)) : null
    return {
      ok: false,
      message:
        where === "queued"
          ? `Can't approve the plan for "${id}": it's still queued — the loop hasn't planned it yet (loop_start runs its PLAN stage).`
          : where === "draft"
            ? `Can't approve the plan for "${id}": it's a draft — approve the task first with loop_task_approve.`
            : where
              ? `Can't approve the plan for "${id}": it's in ${where} — only plan-review tasks can be plan-approved.`
              : `Can't approve the plan for "${id}": no task found.`,
    }
  }
  if (!hasPlan(task)) return { ok: false, message: `Task "${id}" has no Implementation Plan — send it back with loop_replan.` }
  const actor = await gitActor(sh, directory)
  await appendNote(sh, task, auditNote("Plan approved — parked for execution", new Date(), actor), log)
  const newPath = await moveTask(sh, task, "in-progress")
  await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
  return {
    ok: true,
    message: `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/ for execution.`,
    path: newPath,
    data: { approved: true, path: newPath, next: `loop_start with id "${id}", or loop_claim` },
  }
}

/**
 * replan: a rejected plan-review/ or cap-tripped in-progress/ task → queued/.
 * `liveTaskId` is the id of the task a live loop is currently driving (the
 * in-memory `active` for the MCP tool; the on-disk stage marker for the CLI) —
 * refused so we never re-queue a task mid-build.
 */
const replanTask = async (id: string, reason: string | undefined, liveTaskId: string | null): Promise<GateResult> => {
  if (liveTaskId === id) return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agent-loop stop).` }
  const task =
    (await findByIdIn(sh, directory, config.tasksDir, "plan-review", id)) ??
    (await findByIdIn(sh, directory, config.tasksDir, "in-progress", id))
  if (!task) {
    const elsewhere = await findAnyStatus(id)
    return {
      ok: false,
      message: elsewhere
        ? `Can't replan "${id}": it's in ${path.basename(path.dirname(elsewhere.path))} — only plan-review or in-progress tasks can be sent back to planning.`
        : `Can't replan "${id}": no task found.`,
    }
  }
  const actor = await gitActor(sh, directory)
  const why = reason ? ` — ${reason}` : ""
  await appendNote(sh, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor), log)
  const newPath = await moveTask(sh, task, "queued")
  await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan rejected — re-queued for planning`)
  return {
    ok: true,
    message: `"${task.title}" sent back to ${config.tasksDir}/queued/ — the next PLAN pass will address the rejection.`,
    path: newPath,
    data: { requeued: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) re-plans it` },
  }
}

server.registerTool(
  "loop_task_approve",
  {
    description:
      "Deterministic /agent-loop-task approve <id> — the task gate: move a reviewed draft/ task to queued/ (audited note + commit). No plan is required or expected; the loop's PLAN stage writes it right before execution. The agent writes nothing.",
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
      "Deterministic /agent-loop-task approve-plan <id> — the plan gate: validate the plan-review/ task has an ## Implementation Plan, move it to in-progress/ (the build-ready queue), append an audited note, and commit. Refuses planless tasks. The agent writes nothing.",
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
      "Deterministic /agent-loop-task replan <id> [reason]: reject a parked plan (plan-review/) or send a cap-tripped in-progress/ task back to queued/ with an audited note, so the next PLAN pass addresses why the old plan failed. Refuses tasks a live loop is driving.",
    inputSchema: { id: z.string().min(1), reason: z.string().max(500).optional() },
  },
  async ({ id, reason }) => {
    await loadCfg()
    const r = await replanTask(id, reason, active?.task?.id ?? null)
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
  { description: "Ship a reviewed task: move it in-review/ → completed/ with an audited note and commit. The final human gate action.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    await loadCfg()
    const t = await findByIdIn(sh, directory, config.tasksDir, "in-review", id)
    if (!t) {
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Can't ship "${id}": it's in ${path.basename(path.dirname(elsewhere.path))}, not in-review/.`
          : `No in-review task "${id}".`,
      )
    }
    await appendNote(sh, { id, path: t.path }, auditNote("Shipped — moved to completed", new Date(), await gitActor(sh, directory)), log)
    const newPath = await moveTask(sh, { id, path: t.path }, "completed")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): shipped — completed`)
    return ok({ completed: newPath })
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
    const t = await findByIdIn(sh, directory, config.tasksDir, "in-progress", id)
    if (!t) return fail(`No in-progress task "${id}".`)
    if (isClaimable(t)) return fail(`Task "${id}" never started — start it with loop_start or loop_claim.`)
    if (!isRecoverable(t)) return fail(`Task "${id}" has no Implementation Plan — send it back to planning with loop_replan.`)
    await claimTask(sh, t) // re-mark; the dead run's claim marker may linger
    const snap = await loadState(fsClient, directory, config.tasksDir, id)
    samples = []
    pending = null
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
    active = resumeAtBuild(taskGoal(t), taskRef(t, t.path), extractPlan(t) ?? "")
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
  const [verb, id, ...rest] = argv
  const reason = rest.join(" ").trim() || undefined
  const emit = (r: GateResult) => process.stdout.write(`${JSON.stringify(r)}\n`)
  if (!verb || !id) {
    emit({ ok: false, message: "Usage: gate <approve|approve-plan|replan> <id> [reason]" })
    return 1
  }
  await loadCfg()
  let result: GateResult
  if (verb === "approve") result = await approveTask(id)
  else if (verb === "approve-plan") result = await approvePlan(id)
  else if (verb === "replan") result = await replanTask(id, reason, readStageTaskId())
  else result = { ok: false, message: `Unknown gate verb "${verb}" — expected approve, approve-plan, or replan.` }
  emit(result)
  return result.ok ? 0 : 1
}

// --- boot ---

async function main() {
  await loadCfg()
  // Boot reconciliation: prune vanished worktrees, surface survivors (never auto-delete).
  if (config.worktreesDir) {
    await pruneWorktrees(sh, directory)
    const worktrees = (await listWorktrees(sh, directory)).filter((w) => w.branch?.startsWith("loop/"))
    for (const w of worktrees) await log("info", `leftover loop worktree: ${w.path} (${w.branch}) — /agent-loop recover its task or remove it`)
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
