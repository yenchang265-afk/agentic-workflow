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
import { loadManifest } from "@agentic-loop/core/manifest/load"
import { stageDef } from "@agentic-loop/core/manifest/schema"
import { fileURLToPath } from "node:url"
import { failedCriteriaBlock, worstOf, type CriterionResult, type Verdict, type VerdictRecord } from "@agentic-loop/core/loop/verdict"
import { renderRunSummary, type Outcome, type StageSample } from "@agentic-loop/core/loop/metrics"
import { commitAll, commitPaths, gitActor, listWorktrees, pruneWorktrees } from "@agentic-loop/core/loop/git"
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
  isRecoverable,
  listByStatus,
  listInProgress,
  listQueued,
  moveTask,
  releaseClaim,
  selectNext,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "@agentic-loop/core/task/store"

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
/** The loop-kind manifests shipped with this repo (loops/<kind>/) — resolved
 *  relative to this module so the server works from any cwd. */
const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "loops")
/** The engineering loop kind — the only kind this server drives until the multi-kind scheduler lands. */
const eng = loadManifest(LOOPS_DIR, "engineering")
const log = (level: "info" | "warn" | "error", message: string) =>
  fsClient.app.log({ body: { service: "agentic-loop", level, message } })

// --- shared in-process loop state (one active loop per server/session) ---

let active: LoopState | null = null
let pending: VerdictRecord | null = null // verdict(s) recorded for the current check stage
let samples: StageSample[] = [] // per-run metrics
let lastFireAt = Date.now()
let stageDeadline: number | null = null // wall-clock cap for the stage in flight
let config: Config = DEFAULT_CONFIG

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
      const def = stageDef(eng.manifest, stage)
      stageDeadline = Date.now() + (def.timeoutMinutes ?? config.stageTimeoutMinutes) * 60_000
      fs.writeFileSync(
        stageMarkerPath(),
        JSON.stringify({
          kind: eng.manifest.kind,
          stage,
          worktree: active?.git?.worktree ?? null,
          deadline: stageDeadline,
          ...(def.kind === "check" ? { bashAllowlist: def.bashAllowlist } : {}),
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

/** Serialize a value into an MCP text result. */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] })

/** Locate which status folder a task id lives in. */
const findAnyStatus = async (id: string): Promise<Task | null> => {
  for (const s of STATUSES) {
    const t = await findByIdIn(fsClient, directory, config.tasksDir, s, id)
    if (t) return t
  }
  return null
}

/** Claim an approved in-progress task and construct its build-entry state.
 *  Shared by loop_start and loop_claim. */
const startTask = async (t: Task): Promise<{ error: string } | { state: LoopState }> => {
  if (!(await claimTask(sh, t))) return { error: `Task "${t.id}" was just claimed by another session.` }
  samples = []
  pending = null
  let state = resumeAtBuild(taskGoal(t), taskRef(t, t.path), extractPlan(t) ?? "")
  try {
    state = await ensureIsolation(sh, log, directory, config, state)
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

/** The fire payload loop_start/loop_claim return for a fresh claim. */
const firePayload = (state: LoopState, id: string) => ({
  action: { kind: "fire", stage: state.stage },
  taskId: id,
  isolation: state.git ?? null,
  prompt: composePrompt(eng, state, state.stage),
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
    const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", id)
    if (!t) {
      const queued = await findByIdIn(fsClient, directory, config.tasksDir, "queued", id)
      if (queued) {
        const started = await startPlan(queued)
        if ("error" in started) return fail(started.error)
        return ok(firePayload(started.state, id))
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
    return ok(firePayload(started.state, id))
  },
)

server.registerTool(
  "loop_claim",
  {
    description:
      "Claim the next task and start it — the pull equivalent of the OpenCode plugin's /agent-loop watch. Build-ready in-progress/ tasks win over planless queued/ ones (finish work in flight before planning new work); within each pool, lowest priority number first. Returns null when both pools are empty.",
    inputSchema: {},
  },
  async () => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    const tasks = (await listInProgress(fsClient, directory, config.tasksDir, log)).filter(isClaimable)
    const t = selectNext(tasks)
    if (t) {
      const started = await startTask(t)
      if ("error" in started) return fail(started.error)
      return ok(firePayload(started.state, t.id))
    }
    const queued = selectNext(await listQueued(fsClient, directory, config.tasksDir, log))
    if (!queued) return ok(null)
    const started = await startPlan(queued)
    if ("error" in started) return fail(started.error)
    return ok(firePayload(started.state, queued.id))
  },
)

server.registerTool(
  "loop_compose",
  {
    description: "Return the composed prompt (goal + relevant prior artifacts + isolation lines) to hand a stage subagent.",
    inputSchema: { stage: z.enum(["plan", "build", "verify", "review"]) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    return ok({ prompt: composePrompt(eng, active, stage) })
  },
)

server.registerTool(
  "loop_verdict",
  {
    description:
      "Record the VERIFY or REVIEW verdict for the running loop. THE ONLY TRUSTED verdict channel — a PASS/FAIL in prose is ignored. Called by the loop-verify/loop-review subagent exactly once per pass. Multiple calls in one stage (multi-lens review) are combined worst-wins.",
    inputSchema: {
      stage: z.enum(["verify", "review"]),
      verdict: z.enum(["PASS", "FAIL", "ERROR"]),
      reason: z.string().max(500).optional(),
      criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean() })).optional(),
    },
  },
  async ({ stage, verdict, reason, criteria }) => {
    if (!active) return fail("No active loop — verdict ignored.")
    if (active.stage !== stage) return fail(`The loop is at ${active.stage}, not ${stage} — verdict ignored.`)
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
      active = await ensureIsolation(sh, log, directory, config, active)
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
    inputSchema: { stage: z.enum(["plan", "build", "verify", "review"]) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    if (stageDef(eng.manifest, stage).isolation !== "none") {
      // A no-isolation stage (engineering's PLAN) runs in the main tree — no branch, no worktree to reconcile.
      try {
        active = await ensureIsolation(sh, log, directory, config, active) // reconcile a moved/vanished worktree
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
      ...(stageDef(eng.manifest, stage).kind === "check" ? { verdict: (pending?.verdict ?? "none") as Verdict | "none" } : {}),
    })
    // thread failed criteria ahead of the prose for the next iteration
    const block = failedCriteriaBlock(pending)
    const threaded = block ? `${block}\n\n${stageOutput}` : stageOutput
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      await commitAll(sh, workTree(), `loop(${loopId(active)}): build checkpoint (iteration ${active.iteration + 1})`)
    }
    if (stageDef(eng.manifest, stage).kind === "check" && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending?.verdict ?? "none → FAIL"}${failed ? ` (${failed} criteria unmet)` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    const verdict = stageDef(eng.manifest, stage).kind === "check" ? (pending?.verdict ?? null) : null
    const { state, action } = advance(eng, active, config, threaded, verdict)
    active = state
    pending = null

    if (action.kind === "fire") {
      await snapshot()
      return ok({
        action: { kind: "fire", stage: action.stage },
        prompt: composePrompt(eng, active, action.stage),
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
    await snapshot()
    await runTerminal(action)
    return ok({ action: { kind: action.kind, message: (action as { message: string }).message } })
  },
)

/** Terminal bookkeeping for the PLAN stage's park: validate, move, commit, clear. */
const runPark = async (
  action: Extract<Action, { kind: "park" }>,
): Promise<{ error: string } | { action: { kind: "park"; message: string }; path: string; next: string }> => {
  if (!active?.task) {
    active = null
    writeStageMarker(null)
    return { error: "No task-backed loop to park." }
  }
  const id = active.task.id
  const fresh = await findByIdIn(fsClient, directory, config.tasksDir, "queued", id)
  const actor = await gitActor(sh, directory)
  if (!fresh || !hasPlan(fresh)) {
    const why = fresh ? "the PLAN stage wrote no ## Implementation Plan" : "the task left queued/ mid-plan"
    if (fresh) {
      await appendNote(sh, fresh, auditNote(`PLAN stage failed — ${why}; still queued`, new Date(), actor), log)
      await releaseClaim(sh, fresh)
    }
    const summary = renderRunSummary(samples, "error", why, config.maxIterations, new Date().toISOString())
    await appendRunLog(sh, directory, config.tasksDir, id, "run · error", summary, log)
    active = null
    writeStageMarker(null)
    return { error: `PLAN failed for "${id}" — ${why}. It stays in queued/.` }
  }
  await appendNote(sh, fresh, auditNote("Plan written — parked for plan review", new Date(), actor), log)
  const newPath = await moveTask(sh, fresh, (action.toStatus ?? "plan-review") as TaskStatus) // also releases the queued/ claim marker
  await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan written — parked for review`)
  const summary = renderRunSummary(samples, "done", "plan parked for review", config.maxIterations, new Date().toISOString())
  await appendRunLog(sh, directory, config.tasksDir, id, "run · done", summary, log)
  active = null
  writeStageMarker(null)
  return {
    action: { kind: "park", message: action.message },
    path: newPath,
    next: `human reviews the plan, then loop_plan_approve("${id}") or loop_replan("${id}")`,
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
      await appendNote(sh, active.task, auditNote("Loop done — review passed, awaiting human diff review", new Date(), actor), log)
      await moveTask(sh, active.task, ((action as { toStatus?: string }).toStatus ?? "in-review") as TaskStatus)
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
    return ok({ active: active ? { stage: active.stage, iteration: active.iteration + 1, task: active.task?.id ?? active.goal } : null, backlog: summary })
  },
)

server.registerTool(
  "loop_task_approve",
  {
    description:
      "Deterministic /agent-loop-task approve <id> — the task gate: move a reviewed draft/ task to queued/ (audited note + commit). No plan is required or expected; the loop's PLAN stage writes it right before execution. The agent writes nothing.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const draft = await findByIdIn(fsClient, directory, config.tasksDir, "draft", id)
    if (!draft) {
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Can't approve "${id}": it's in ${path.basename(path.dirname(elsewhere.path))} — only draft tasks can be approved.`
          : `Can't approve "${id}": no task found.`,
      )
    }
    const actor = await gitActor(sh, directory)
    await appendNote(sh, draft, auditNote("Task approved — queued for planning", new Date(), actor), log)
    const newPath = await moveTask(sh, draft, "queued")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): task approved — queued for planning`)
    return ok({ approved: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) runs its PLAN stage` })
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
    const task = await findByIdIn(fsClient, directory, config.tasksDir, "plan-review", id)
    if (!task) {
      const elsewhere = await findAnyStatus(id)
      const where = elsewhere ? path.basename(path.dirname(elsewhere.path)) : null
      return fail(
        where === "queued"
          ? `Can't approve the plan for "${id}": it's still queued — the loop hasn't planned it yet (loop_start runs its PLAN stage).`
          : where === "draft"
            ? `Can't approve the plan for "${id}": it's a draft — approve the task first with loop_task_approve.`
            : where
              ? `Can't approve the plan for "${id}": it's in ${where} — only plan-review tasks can be plan-approved.`
              : `Can't approve the plan for "${id}": no task found.`,
      )
    }
    if (!hasPlan(task)) return fail(`Task "${id}" has no Implementation Plan — send it back with loop_replan.`)
    const actor = await gitActor(sh, directory)
    await appendNote(sh, task, auditNote("Plan approved — parked for execution", new Date(), actor), log)
    const newPath = await moveTask(sh, task, "in-progress")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
    return ok({ approved: true, path: newPath, next: `loop_start with id "${id}", or loop_claim` })
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
    if (active?.task?.id === id) return fail(`Task "${id}" is being driven by the active loop — loop_stop it first.`)
    const task =
      (await findByIdIn(fsClient, directory, config.tasksDir, "plan-review", id)) ??
      (await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", id))
    if (!task) {
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Can't replan "${id}": it's in ${path.basename(path.dirname(elsewhere.path))} — only plan-review or in-progress tasks can be sent back to planning.`
          : `Can't replan "${id}": no task found.`,
      )
    }
    const actor = await gitActor(sh, directory)
    const why = reason ? ` — ${reason}` : ""
    await appendNote(sh, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor), log)
    const newPath = await moveTask(sh, task, "queued")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan rejected — re-queued for planning`)
    return ok({ requeued: true, path: newPath, next: `loop_start with id "${id}" (or loop_claim) re-plans it` })
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
    const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-review", id)
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
    const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", id)
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
        active = await ensureIsolation(sh, log, directory, config, active)
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
      active = await ensureIsolation(sh, log, directory, config, active)
    } catch (err) {
      active = null
      return fail((err as Error).message)
    }
    await appendNote(sh, active.task as TaskRef, auditNote("Recovered from persisted plan — re-entering at BUILD", new Date(), actor), log)
    await snapshot()
    return ok({ resumedFrom: "plan", stage: "build", prompt: composePrompt(eng, active, "build"), note: "call loop_stage before spawning the subagent" })
  },
)

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

main().catch((err) => {
  process.stderr.write(`agentic-loop MCP fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
