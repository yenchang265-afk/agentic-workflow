#!/usr/bin/env node
import path from "node:path"
import fs from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { fsClient, sh } from "./shim.js"
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js"
import { advanceOnIdle, composeArgs, createState, firstStep, resume, type Action, type Config, type LoopState, type TaskRef } from "./lib/loop/state.js"
import { failedCriteriaBlock, worstOf, type CriterionResult, type Verdict, type VerdictRecord } from "./lib/loop/verdict.js"
import { renderRunSummary, type Outcome, type StageSample } from "./lib/loop/metrics.js"
import {
  addWorktree,
  checkoutBranch,
  commitAll,
  commitPaths,
  currentBranch,
  ensureExcluded,
  gitActor,
  isGitRepo,
  removeWorktree,
} from "./lib/loop/git.js"
import { clearState, loadState, saveState } from "./lib/loop/persist.js"
import { slugify, type Task } from "./lib/task/schema.js"
import {
  appendNote,
  auditNote,
  extractPlan,
  findById,
  findByIdIn,
  hasPlan,
  listByStatus,
  listInPlanning,
  moveTask,
  selectNext,
  STATUSES,
  summarizeBacklog,
  writeTask,
  type TaskStatus,
} from "./lib/task/store.js"

/**
 * MCP server backing the agentic-loop Claude Code plugin. It holds the loop's
 * LoopState (the same pure state machine the OpenCode driver used) and exposes
 * the deterministic/trusted operations as tools the MAIN agent calls while it
 * drives PLAN→BUILD→VERIFY→REVIEW via the Task tool. The autonomous background
 * driver is gone (no Claude Code equivalent) — the agent is the driver; this
 * server is the trusted state + git/backlog substrate.
 */

const directory = process.env.AGENTIC_LOOP_DIR ?? process.cwd()
const log = (level: string, message: string) => fsClient.app.log({ body: { service: "agentic-loop", level, message } })

// --- shared in-process loop state (one active loop per server/session) ---

let active: LoopState | null = null
let pending: VerdictRecord | null = null // verdict(s) recorded for the current check stage
let samples: StageSample[] = [] // per-run metrics
let lastFireAt = Date.now()
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
  ...(t.azureId !== undefined ? { azureId: t.azureId } : {}),
  ...(t.azureUrl !== undefined ? { azureUrl: t.azureUrl } : {}),
})
const loopId = (s: LoopState): string => s.task?.id ?? slugify(s.goal.split("\n")[0] ?? "goal") ?? "goal"
const stageMarkerPath = () => path.join(directory, config.tasksDir, "runs", ".stage.json")

/** Write the current-stage marker the PreToolUse hook reads to scope the allowlist. */
const writeStageMarker = (stage: string | null) => {
  const dir = path.join(directory, config.tasksDir, "runs")
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (stage === null) fs.rmSync(stageMarkerPath(), { force: true })
    else fs.writeFileSync(stageMarkerPath(), JSON.stringify({ stage, worktree: active?.git?.worktree ?? null }))
  } catch {
    /* best-effort */
  }
}

const snapshot = async () => {
  if (active?.task) await saveState(sh, directory, config.tasksDir, active.task.id, active)
}

const workTree = () => active?.git?.worktree ?? directory

/** Serialize a value into an MCP text result. */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] })
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] })

// --- server + tools ---

const server = new McpServer({ name: "agentic-loop", version: "0.0.1" })

server.registerTool(
  "loop_start",
  {
    description:
      "Begin a loop for a goal. Creates (or claims) a backing task in in-progress/, initializes the state machine at PLAN, and returns the composed PLAN prompt to hand the loop-plan subagent. Pass taskId to start from an existing in-planning task.",
    inputSchema: {
      goal: z.string().min(1).describe("The goal text (ignored if taskId is given and the task carries its own body)."),
      taskId: z.string().optional().describe("An existing in-planning task id to start from."),
    },
  },
  async ({ goal, taskId }) => {
    await loadCfg()
    samples = []
    pending = null
    let ref: TaskRef | undefined
    let realGoal = goal
    if (taskId) {
      const t = await findById(fsClient, directory, config.tasksDir, taskId)
      if (!t) return fail(`No in-planning task "${taskId}".`)
      const newPath = await moveTask(sh, { id: t.id, path: t.path }, "in-progress")
      ref = taskRef(t, newPath)
      realGoal = taskGoal(t)
    } else {
      const [first = "", ...rest] = goal.split("\n")
      const title = first.trim().slice(0, 79) || "Loop task"
      const written = await writeTask(sh, fsClient, { directory, tasksDir: config.tasksDir, status: "in-progress" }, { title, body: rest.join("\n").trim() })
      const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", written.id)
      if (t) ref = taskRef(t, written.path)
    }
    active = createState(realGoal, ref)
    const actor = await gitActor(sh, directory)
    if (ref) await appendNote(sh, ref, auditNote("Loop started", new Date(), actor), log)
    writeStageMarker("plan")
    lastFireAt = Date.now()
    await snapshot()
    return ok({ action: { kind: "fire", stage: "plan" }, taskId: ref?.id ?? null, prompt: composeArgs(active, "plan") })
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

/** Ensure the loop's git isolation exists (idempotent). Returns a description. */
const doIsolate = async (): Promise<{ isolated: boolean; branch?: string; worktree?: string | null; reused?: boolean; note?: string; error?: string }> => {
  if (!active) return { isolated: false, error: "no active loop" }
  if (active.git) return { isolated: true, branch: active.git.branch, worktree: active.git.worktree ?? null, reused: true }
  if (!(await isGitRepo(sh, directory))) return { isolated: false, note: "not a git repo — building in place" }
  const base = await currentBranch(sh, directory)
  if (!base) return { isolated: false, note: "detached HEAD — building in place" }
  const branch = `loop/${loopId(active)}`
  if (config.worktreesDir) {
    const wt = path.resolve(directory, config.worktreesDir, loopId(active))
    await ensureExcluded(sh, directory, config.worktreesDir)
    if (!(await addWorktree(sh, directory, wt, branch, base))) return { isolated: false, error: `could not create worktree ${wt}` }
    if (config.worktreeSetup) await sh`${{ raw: config.worktreeSetup }}`.cwd(wt)
    active = { ...active, git: { base, branch, worktree: wt } }
  } else {
    if (!(await checkoutBranch(sh, directory, branch))) return { isolated: false, error: `could not check out ${branch}` }
    active = { ...active, git: { base, branch } }
  }
  await snapshot()
  return { isolated: true, branch, worktree: active.git?.worktree ?? null }
}

server.registerTool(
  "loop_approve",
  {
    description:
      "Approve the plan at the human gate and proceed to BUILD: isolates execution (loop/<id> branch or worktree) and returns the fire-build action + composed prompt. Call this after the user approves the plan shown at the gate.",
    inputSchema: {},
  },
  async () => {
    if (!active) return fail("No active loop.")
    if (!active.paused || active.stage !== "plan") return fail("Loop is not at a plan gate.")
    const iso = await doIsolate()
    if (iso.error) return fail(iso.error)
    const { state, action } = resume(active)
    active = state
    await snapshot()
    if (action.kind === "fire") {
      writeStageMarker(action.stage)
      lastFireAt = Date.now()
      return ok({ isolation: iso, action: { kind: "fire", stage: action.stage }, prompt: composeArgs(active, action.stage) })
    }
    return ok({ isolation: iso, action })
  },
)

server.registerTool(
  "loop_isolate",
  {
    description:
      "Explicitly create the loop/<id> branch (or worktree when worktreesDir is set). Normally loop_approve does this; use it standalone only when recovering.",
    inputSchema: {},
  },
  async () => {
    if (!active) return fail("No active loop.")
    const iso = await doIsolate()
    if (iso.error) return fail(iso.error)
    return ok(iso)
  },
)

server.registerTool(
  "loop_stage",
  {
    description: "Set the current stage marker so the PreToolUse hook enforces the right bash allowlist (default-deny for verify/review). Call right before spawning each stage subagent.",
    inputSchema: { stage: z.enum(["plan", "build", "verify", "review"]) },
  },
  async ({ stage }) => {
    if (!active) return fail("No active loop.")
    writeStageMarker(stage)
    lastFireAt = Date.now()
    pending = null // no stale verdict may leak into this stage
    return ok({ stage, worktree: active.git?.worktree ?? null })
  },
)

server.registerTool(
  "loop_advance",
  {
    description:
      "Feed a completed stage's output back into the state machine and get the next action. Returns {kind:'fire',stage,prompt} to run the next stage, {kind:'gate'} to pause for human plan approval, or {kind:'done'|'stop'} (terminal — the task is moved and metrics written). Uses the verdict recorded via loop_verdict for check stages.",
    inputSchema: { stageOutput: z.string().describe("The finished stage subagent's summary/output text.") },
  },
  async ({ stageOutput }) => {
    if (!active) return fail("No active loop.")
    const stage = active.stage
    const verdict = pending?.verdict ?? (stage === "verify" || stage === "review" ? null : undefined)
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
    if ((stage === "verify" || stage === "review") && active.task) {
      const failed = pending?.criteria?.filter((c) => !c.pass).length ?? 0
      await appendNote(sh, active.task, auditNote(`${stage.toUpperCase()} verdict: ${pending?.verdict ?? "none → FAIL"}${failed ? ` (${failed} criteria unmet)` : ""} (iteration ${active.iteration + 1})`, new Date(), actor), log)
    }
    const { state, action } = advanceOnIdle(active, config, threaded, verdict ?? null)
    active = state
    pending = null
    await snapshot()

    if (action.kind === "fire") {
      writeStageMarker(action.stage)
      lastFireAt = Date.now()
      return ok({ action: { kind: "fire", stage: action.stage }, prompt: composeArgs(active, action.stage) })
    }
    if (action.kind === "gate") return ok({ action: { kind: "gate", message: action.message } })
    // terminal: done / stop
    await runTerminal(action)
    return ok({ action: { kind: action.kind, message: (action as { message: string }).message } })
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
  const { appendRunLog } = await import("./lib/task/store.js")
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
  // teardown worktree (best-effort) / clear snapshot
  if (active.git?.worktree) await removeWorktree(sh, directory, active.git.worktree)
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
  "loop_next",
  { description: "Pick the highest-priority un-planned task in in-planning/ (the /loop next target). Returns its id and goal, or null.", inputSchema: {} },
  async () => {
    await loadCfg()
    const tasks = (await listInPlanning(fsClient, directory, config.tasksDir, log)).filter((t) => !hasPlan(t))
    const t = selectNext(tasks)
    return ok(t ? { id: t.id, goal: taskGoal(t) } : null)
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
    if (!t) return fail(`No in-review task "${id}".`)
    await appendNote(sh, { id, path: t.path }, auditNote("Shipped — moved to completed", new Date(), await gitActor(sh, directory)), log)
    const newPath = await moveTask(sh, { id, path: t.path }, "completed")
    await commitPaths(sh, directory, [config.tasksDir], `loop(${id}): shipped — completed`)
    return ok({ completed: newPath })
  },
)

server.registerTool(
  "loop_recover",
  { description: "Resume an interrupted in-progress task from its state snapshot (exact stage) or, failing that, from its persisted plan at BUILD. Returns the next action + prompt.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    await loadCfg()
    const t = await findByIdIn(fsClient, directory, config.tasksDir, "in-progress", id)
    if (!t) return fail(`No in-progress task "${id}".`)
    const snap = await loadState(fsClient, directory, config.tasksDir, id)
    samples = []
    pending = null
    if (snap && snap.task?.id === id) {
      active = { ...snap, task: { ...snap.task, path: t.path } }
      const step = firstStep(active)
      writeStageMarker(active.stage)
      lastFireAt = Date.now()
      return ok({ resumedFrom: "snapshot", stage: active.stage, action: step.action })
    }
    const { resumeAtBuild } = await import("./lib/loop/state.js")
    active = resumeAtBuild(taskGoal(t), taskRef(t, t.path), extractPlan(t) ?? "")
    writeStageMarker("build")
    lastFireAt = Date.now()
    await snapshot()
    return ok({ resumedFrom: "plan", stage: "build", prompt: composeArgs(active, "build") })
  },
)

/** Locate which status folder a task id lives in. */
const findAnyStatus = async (id: string): Promise<Task | null> => {
  for (const s of STATUSES) {
    const t = await findByIdIn(fsClient, directory, config.tasksDir, s, id)
    if (t) return t
  }
  return null
}

// --- boot ---

async function main() {
  await loadCfg()
  await log("info", `agentic-loop MCP server ready (directory=${directory})`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`agentic-loop MCP fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
