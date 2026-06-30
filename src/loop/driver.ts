import type { PluginInput } from "@opencode-ai/plugin"
import type { Task } from "../task/schema.ts"
import { appendNote, findById, listApproved, moveTask, selectNext } from "../task/store.ts"
import type { Action, Config, LoopState, TaskRef } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  composeArgs,
  createState,
  getLoop,
  resume,
  setLoop,
} from "./state.ts"

/**
 * Impure orchestration for the agentic loop. Thin glue over the pure helpers in
 * `state.ts`.
 *
 * Stepping is **sequential**: `client.session.command` resolves with the
 * completed stage's assistant message, so the driver fires a stage, captures its
 * output, feeds it back into the pure `advanceOnIdle` decision, and repeats until
 * a non-`fire` action (gate / done / stop). `session.idle` is used only as the
 * trigger to begin a drive once the `/loop` command's own turn settles; a pending
 * marker selects what to run and a driving lock prevents re-entrancy from the
 * idle events the driver's own commands generate.
 *
 * When the loop is started from a backlog task, the driver also moves the task
 * file across its status folders: approved → in-progress on start, → completed on
 * a verify PASS; on a stop/failure it appends a note and leaves it in-progress.
 */

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
  | { readonly kind: "start"; readonly goal: string }
  | { readonly kind: "start-task"; readonly task: Task; readonly goal: string }
  | { readonly kind: "proceed" }

const pending = new Map<string, Pending>()
const driving = new Set<string>()

const toast = (client: Client, message: string, variant: "info" | "success" | "warning" | "error") =>
  client.tui.showToast({ body: { message, variant } }).catch(() => {})

/** A task's goal text: title headline plus its body, if any. */
const taskGoal = (task: Task): string => (task.body ? `${task.title}\n\n${task.body}` : task.title)

const taskRef = (task: Task, path: string): TaskRef => ({
  id: task.id,
  path,
  acceptance: task.acceptance,
})

/** Fire a stage command and return the assistant text it produced. */
const runStage = async (client: Client, sessionID: string, stage: string, args: string): Promise<string> => {
  const res = await client.session.command({
    path: { id: sessionID },
    body: { command: stage, arguments: args },
  })
  const parts = res.data?.parts ?? []
  return parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop. */
const drive = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: LoopState; action: Action },
): Promise<void> => {
  const { client } = deps
  let step = first
  while (step.action.kind === "fire") {
    setLoop(sessionID, step.state)
    const { stage, arguments: args } = step.action
    const output = await runStage(client, sessionID, stage, args)
    step = advanceOnIdle(step.state, config, output)
  }

  const { state, action } = step
  switch (action.kind) {
    case "gate":
      setLoop(sessionID, state)
      await toast(client, action.message, "info")
      return
    case "done":
      if (state.task) {
        try {
          await moveTask(deps.$, state.task, "completed")
        } catch (err) {
          await deps.log("warn", `loop done but task move failed: ${(err as Error).message}`)
        }
      }
      clearLoop(sessionID)
      await toast(client, action.message, "success")
      return
    case "stop":
      // Per design: a failed/stopped task stays in-progress, annotated for a human.
      if (state.task) await appendNote(deps.$, state.task, action.message)
      clearLoop(sessionID)
      await toast(client, action.message, "warning")
      return
    case "noop":
      return
  }
}

const firstStep = (state: LoopState): { state: LoopState; action: Action } => ({
  state,
  action: { kind: "fire", stage: state.stage, arguments: composeArgs(state, state.stage) },
})

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  const work = pending.get(sessionID)
  if (!work || driving.has(sessionID)) return
  pending.delete(sessionID)
  driving.add(sessionID)
  try {
    if (work.kind === "start") {
      await drive(deps, sessionID, config, firstStep(createState(work.goal)))
    } else if (work.kind === "start-task") {
      const newPath = await moveTask(deps.$, work.task, "in-progress")
      const ref = taskRef(work.task, newPath)
      await drive(deps, sessionID, config, firstStep(createState(work.goal, ref)))
    } else {
      const state = getLoop(sessionID)
      if (state?.paused) await drive(deps, sessionID, config, resume(state))
    }
  } catch (err) {
    const message = (err as Error).message
    const state = getLoop(sessionID)
    if (state?.task) await appendNote(deps.$, state.task, `Loop error: ${message}`)
    clearLoop(sessionID)
    await toast(deps.client, `Loop error: ${message}`, "error")
  } finally {
    driving.delete(sessionID)
  }
}

// --- /loop command handling (parses the mode; deferred work runs on next idle) ---

const TASK_PREFIX = "task "

/** Queue a task to start on the next idle, replacing any existing loop. */
const queueTask = async (deps: Deps, sessionID: string, task: Task): Promise<void> => {
  clearLoop(sessionID)
  pending.set(sessionID, { kind: "start-task", task, goal: taskGoal(task) })
  await toast(deps.client, `Loop started on "${task.title}" — exploring then planning…`, "info")
}

/** Parse and handle a `/loop ...` command. */
export const handleCommand = async (
  deps: Deps,
  sessionID: string,
  args: string,
  config: Config,
): Promise<void> => {
  const { client } = deps
  const arg = args.trim()
  const lower = arg.toLowerCase()

  if (lower === "go" || lower === "approve") {
    const state = getLoop(sessionID)
    if (!state) return void (await toast(client, "No active loop. Start one with /loop <goal>.", "warning"))
    if (!state.paused) return void (await toast(client, "Loop is not waiting for approval.", "info"))
    pending.set(sessionID, { kind: "proceed" })
    await toast(client, "Approved — building…", "info")
    return
  }

  if (lower === "stop" || lower === "abort") {
    pending.delete(sessionID)
    const existed = clearLoop(sessionID)
    await toast(client, existed ? "Loop stopped." : "No active loop to stop.", "info")
    return
  }

  if (lower === "next") {
    const tasks = await listApproved(client, deps.directory, config.tasksDir, deps.log)
    const task = selectNext(tasks)
    if (!task) return void (await toast(client, `No approved tasks in ${config.tasksDir}/approved.`, "warning"))
    await queueTask(deps, sessionID, task)
    return
  }

  if (lower.startsWith(TASK_PREFIX)) {
    const id = arg.slice(TASK_PREFIX.length).trim()
    if (!id) return void (await toast(client, "Usage: /loop task <id>.", "warning"))
    const task = await findById(client, deps.directory, config.tasksDir, id)
    if (!task) return void (await toast(client, `No approved task "${id}".`, "warning"))
    await queueTask(deps, sessionID, task)
    return
  }

  if (lower === "status" || lower === "") {
    const state = getLoop(sessionID)
    if (!state) return void (await toast(client, "No active loop.", "info"))
    const where = state.paused ? `${state.stage} (paused at gate)` : state.stage
    const what = state.task ? `task ${state.task.id}` : state.goal
    await toast(client, `Loop: ${where} · iteration ${state.iteration + 1} · ${what}`, "info")
    return
  }

  // Anything else is a free-text goal → start a new loop (replacing any existing one).
  clearLoop(sessionID)
  pending.set(sessionID, { kind: "start", goal: arg })
  await toast(client, "Loop started — exploring then planning…", "info")
}
