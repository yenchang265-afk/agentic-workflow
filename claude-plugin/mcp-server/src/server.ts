#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js"
import {
  advanceOnIdle,
  composeArgs,
  firstStep,
  resumeAtBuild,
  type Action,
  type Config,
  type LoopState,
  type TaskRef,
} from "./lib/loop/state.js"
import { failedCriteriaBlock, worstOf, type CriterionResult, type Verdict, type VerdictRecord } from "./lib/loop/verdict.js"
import { renderRunSummary, type Outcome, type StageSample } from "./lib/loop/metrics.js"
import { commitAll, commitPaths, gitActor, listWorktrees, pruneWorktrees } from "./lib/loop/git.js"
import { ensureIsolation, loopId, teardownIsolation } from "./lib/loop/isolate.js"
import { clearState, loadState, saveState } from "./lib/loop/persist.js"
import { type Task } from "./lib/task/schema.js"
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
  moveTask,
  selectNext,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
} from "./lib/task/store.js"

/**
 * MCP server backing the agentic-loop Claude Code plugin. It holds the loop's
 * LoopState (the same pure state machine the OpenCode driver uses) and exposes
 * the deterministic/trusted operations as tools the MAIN agent calls while it
 * drives BUILD→VERIFY→REVIEW via the Task tool. The autonomous background
 * driver is gone (no Claude Code equivalent) — the agent is the driver; this
 * server is the trusted state + git/backlog substrate.
 *
 * Planning happens before the loop, in `/agent-loop-plan`: `new` interviews the user
 * into a draft (main-agent turn), `loop_plan_task` moves a draft to
 * `in-planning/` for the plan-writing turn, and `loop_plan_approve` validates
 * the plan and parks the task in `in-progress/` — the approved queue that
 * `loop_start`/`loop_claim` execute from, entering at BUILD.
 *
 * There is no `/agent-loop watch` here, deliberately: watch needs an autonomous
 * driver firing stages on idle events/timers, and the MCP server can't spawn
 * subagents. `loop_claim` is the pull equivalent — one human trigger claims
 * the next approved task.
 */

const directory = process.env.AGENTIC_LOOP_DIR ?? process.cwd()
const log = (level: string, message: string) => fsClient.app.log({ body: { service: "agentic-loop", level, message } })

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
      stageDeadline = Date.now() + config.stageTimeoutMinutes * 60_000
      fs.writeFileSync(
        stageMarkerPath(),
        JSON.stringify({ stage, worktree: active?.git?.worktree ?? null, deadline: stageDeadline }),
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

// --- server + tools ---

const server = new McpServer({ name: "agentic-loop", version: "0.0.1" })

server.registerTool(
  "loop_start",
  {
    description:
      "Execute one approved task now: claims it from in-progress/ (the queue /agent-loop-plan approve fills), isolates execution (loop/<id> branch or worktree), initializes the state machine at BUILD, and returns the composed BUILD prompt. Call loop_stage('build') right before spawning the build subagent.",
    inputSchema: { id: z.string().min(1).describe("The approved task's id (filename without .md) in in-progress/.") },
  },
  async ({ id }) => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", id)
    if (!t) {
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Task "${id}" is in ${path.basename(path.dirname(elsewhere.path))} — only approved in-progress tasks can be executed. Plan it with /agent-loop-plan task ${id} and approve it first.`
          : `No task "${id}" found.`,
      )
    }
    if (!isClaimable(t)) {
      return fail(
        isRecoverable(t)
          ? `Task "${id}" has already started — resume it with loop_recover instead.`
          : `Task "${id}" has no Implementation Plan — run /agent-loop-plan task ${id}, then approve it.`,
      )
    }
    const started = await startTask(t)
    if ("error" in started) return fail(started.error)
    return ok({
      action: { kind: "fire", stage: "build" },
      taskId: id,
      isolation: started.state.git ?? null,
      prompt: composeArgs(started.state, "build"),
    })
  },
)

server.registerTool(
  "loop_claim",
  {
    description:
      "Claim the next approved task from in-progress/ (lowest priority number first) and start it at BUILD — the pull equivalent of the OpenCode plugin's /agent-loop watch. Returns null when the queue is empty.",
    inputSchema: {},
  },
  async () => {
    await loadCfg()
    if (active) return fail(`A loop is already driving "${loopId(active)}" — finish or loop_stop it first.`)
    const tasks = (await listInProgress(fsClient, directory, config.tasksDir, log)).filter(isClaimable)
    const t = selectNext(tasks)
    if (!t) return ok(null)
    const started = await startTask(t)
    if ("error" in started) return fail(started.error)
    return ok({
      action: { kind: "fire", stage: "build" },
      taskId: t.id,
      isolation: started.state.git ?? null,
      prompt: composeArgs(started.state, "build"),
    })
  },
)

server.registerTool(
  "loop_compose",
  {
    description: "Return the composed prompt (goal + relevant prior artifacts + isolation lines) to hand a stage subagent.",
    inputSchema: { stage: z.enum(["build", "verify", "review"]) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    return ok({ prompt: composeArgs(active, stage) })
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
      "Set the current stage marker so the PreToolUse hook enforces the right bash allowlist (default-deny for verify/review) and the stage deadline. Call right before spawning EACH stage subagent, build included. Setting 'build' appends the audited 'BUILD started' note the claimability predicates key on.",
    inputSchema: { stage: z.enum(["build", "verify", "review"]) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    try {
      active = await ensureIsolation(sh, log, directory, config, active) // reconcile a moved/vanished worktree
    } catch (err) {
      return fail((err as Error).message)
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
      ...(stage === "verify" || stage === "review" ? { verdict: (pending?.verdict ?? "none") as Verdict | "none" } : {}),
    })
    // thread failed criteria ahead of the prose for the next iteration
    const block = failedCriteriaBlock(pending)
    const threaded = block ? `${block}\n\n${stageOutput}` : stageOutput
    const actor = await gitActor(sh, directory)
    if (stage === "build" && active.task) {
      await appendNote(sh, active.task, auditNote(`BUILD finished (iteration ${active.iteration + 1})`, new Date(), actor), log)
      await commitAll(sh, workTree(), `loop(${loopId(active)}): build checkpoint (iteration ${active.iteration + 1})`)
    }
    if ((stage === "verify" || stage === "review") && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending?.verdict ?? "none → FAIL"}${failed ? ` (${failed} criteria unmet)` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    const verdict = stage === "verify" || stage === "review" ? (pending?.verdict ?? null) : null
    const { state, action } = advanceOnIdle(active, config, threaded, verdict)
    active = state
    pending = null
    await snapshot()

    if (action.kind === "fire") {
      return ok({
        action: { kind: "fire", stage: action.stage },
        prompt: composeArgs(active, action.stage),
        note: "call loop_stage before spawning the subagent",
      })
    }
    // terminal: done / stop
    await runTerminal(action)
    return ok({ action: { kind: action.kind, message: (action as { message: string }).message } })
  },
)

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
      await moveTask(sh, active.task, "in-review")
    } else {
      await appendNote(sh, active.task, auditNote((action as { message: string }).message, new Date(), actor), log)
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
  "loop_plan_task",
  {
    description:
      "Deterministic pre-turn work for /agent-loop-plan task <id>: if the task sits in draft/, move it to in-planning/ (audited note + commit) so folder semantics stay honest — the agent then writes the Implementation Plan onto the file in place. Idempotent for tasks already in in-planning/.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    if (await findByIdIn(fsClient, directory, config.tasksDir, "in-planning", id)) {
      return ok({ moved: false, note: `"${id}" is already in in-planning/ — plan it in place.` })
    }
    const draft = await findByIdIn(fsClient, directory, config.tasksDir, "draft", id)
    if (!draft) {
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Task "${id}" is in ${path.basename(path.dirname(elsewhere.path))} — only draft/in-planning tasks can be planned.`
          : `No draft/in-planning task "${id}" found.`,
      )
    }
    const actor = await gitActor(sh, directory)
    await appendNote(sh, draft, auditNote("Planning started — moved to in-planning", new Date(), actor), log)
    const newPath = await moveTask(sh, draft, "in-planning")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): planning started`)
    return ok({ moved: true, path: newPath, note: "write the ## Implementation Plan onto this file in place" })
  },
)

server.registerTool(
  "loop_plan_approve",
  {
    description:
      "Deterministic /agent-loop-plan approve <id>: validate the task has an ## Implementation Plan, move it to in-progress/ (the approved queue), append an audited note, and commit. Refuses planless tasks and tasks still in draft/ — no stage is ever skipped. The agent writes nothing.",
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => {
    await loadCfg()
    const task = await findByIdIn(fsClient, directory, config.tasksDir, "in-planning", id)
    if (!task) {
      if (await findByIdIn(fsClient, directory, config.tasksDir, "draft", id)) {
        return fail(`Task "${id}" is still in draft — run loop_plan_task first so no stage is skipped.`)
      }
      const elsewhere = await findAnyStatus(id)
      return fail(
        elsewhere
          ? `Can't approve "${id}": it's in ${path.basename(path.dirname(elsewhere.path))} — only in-planning tasks can be approved.`
          : `Can't approve "${id}": no task found.`,
      )
    }
    if (!hasPlan(task)) return fail(`Task "${id}" has no Implementation Plan yet — run /agent-loop-plan task ${id} first.`)
    const actor = await gitActor(sh, directory)
    await appendNote(sh, task, auditNote("Plan approved — parked for execution", new Date(), actor), log)
    const newPath = await moveTask(sh, task, "in-progress")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
    return ok({ approved: true, path: newPath, next: `loop_start with id "${id}", or loop_claim` })
  },
)

server.registerTool(
  "loop_move",
  { description: "Move a task file to another status folder.", inputSchema: { id: z.string(), status: z.enum(["draft", "in-planning", "in-progress", "in-review", "completed", "abandoned"]) } },
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
    if (!isRecoverable(t)) return fail(`Task "${id}" has no Implementation Plan — re-plan with /agent-loop-plan task ${id}.`)
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
      const step = firstStep(active)
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
    return ok({ resumedFrom: "plan", stage: "build", prompt: composeArgs(active, "build"), note: "call loop_stage before spawning the subagent" })
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
