import type { PluginInput } from "@opencode-ai/plugin"
import type { Task } from "../task/schema.ts"
import {
  appendNote,
  appendPlan,
  extractPlan,
  findById,
  hasPlan,
  listInPlanning,
  moveTask,
  selectNext,
  wasInterrupted,
} from "../task/store.ts"
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
 * A task starts the loop already sitting in `in-planning/` — moving it there
 * from `draft/` is the first human gate. The driver moves it twice more, both
 * automatically: → in-progress/ the moment a plan is approved (`/loop go` at
 * the plan gate — that approval already is the decision to start writing
 * code, so the move just records it); → completed/ when the loop finishes
 * (ship stage done, after verify PASS and review PASS). On a stop/failure
 * while building it appends a note and leaves the task in-progress. The
 * first time a task's plan gates for approval, it is also persisted onto the
 * task file (`## Implementation Plan`), so `/loop next` can skip
 * already-planned tasks and `/loop task <id>` can resume one after a
 * stopped/restarted session — as long as it's still in `in-planning/`; once
 * a task has moved to `in-progress/`, recovering an interrupted session
 * means moving the file back to `in-planning/` by hand and re-running
 * `/loop task <id>` to re-plan and restart it.
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
  ...(task.azureId !== undefined ? { azureId: task.azureId } : {}),
  ...(task.azureUrl !== undefined ? { azureUrl: task.azureUrl } : {}),
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
    const { task, iteration } = step.state
    const trackBuild = stage === "build" && task
    if (trackBuild) await appendNote(deps.$, task, `BUILD started (iteration ${iteration + 1})`)
    const output = await runStage(client, sessionID, stage, args)
    if (trackBuild) await appendNote(deps.$, task, `BUILD finished (iteration ${iteration + 1})`)
    step = advanceOnIdle(step.state, config, output)
  }

  const { state, action } = step
  switch (action.kind) {
    case "gate":
      setLoop(sessionID, state)
      // Only the plan→build gate persists onto the task file, and only the first
      // time (iteration 0) — re-plans thread the prior plan via the artifact
      // instead. The review→ship gate has no equivalent on-disk persistence.
      if (state.task && state.stage === "plan" && state.iteration === 0) {
        try {
          await appendPlan(deps.$, state.task, state.artifacts.plan ?? "")
        } catch (err) {
          await deps.log("warn", `plan gated but persisting it failed: ${(err as Error).message}`)
        }
      }
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
      const ref = taskRef(work.task, work.task.path)
      await drive(deps, sessionID, config, firstStep(createState(work.goal, ref)))
    } else {
      const state = getLoop(sessionID)
      if (state?.paused) {
        // Resuming from the plan gate is the only case where a human's /loop go
        // means "start writing code" — record that by moving the task file
        // in-planning/ → in-progress/ before firing build. The ship gate (state
        // .stage === "review") has no equivalent move; the task stays in-progress
        // through review → ship.
        let next = state
        if (state.task && state.stage === "plan") {
          try {
            const newPath = await moveTask(deps.$, state.task, "in-progress")
            next = { ...state, task: { ...state.task, path: newPath } }
          } catch (err) {
            await deps.log(
              "warn",
              `plan approved but moving the task to in-progress failed: ${(err as Error).message}`,
            )
          }
        }
        await drive(deps, sessionID, config, resume(next))
      }
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
  await toast(deps.client, `Loop started on "${task.title}" — planning…`, "info")
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
    const state = getLoop(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        `Loop stopped by /loop stop — was at ${state.stage} (iteration ${state.iteration + 1}).`,
      )
    }
    const existed = clearLoop(sessionID)
    await toast(client, existed ? "Loop stopped." : "No active loop to stop.", "info")
    return
  }

  if (lower === "next") {
    const tasks = await listInPlanning(client, deps.directory, config.tasksDir, deps.log)
    const unplanned = tasks.filter((t) => !hasPlan(t))
    const task = selectNext(unplanned)
    if (!task) {
      const message =
        tasks.length === 0
          ? `No tasks in ${config.tasksDir}/in-planning.`
          : "All in-planning tasks already have a plan — run /loop task <id> to review and approve one."
      return void (await toast(client, message, "warning"))
    }
    await queueTask(deps, sessionID, task)
    return
  }

  if (lower.startsWith(TASK_PREFIX)) {
    const id = arg.slice(TASK_PREFIX.length).trim()
    if (!id) return void (await toast(client, "Usage: /loop task <id>.", "warning"))
    const task = await findById(client, deps.directory, config.tasksDir, id)
    if (!task) return void (await toast(client, `No in-planning task "${id}".`, "warning"))
    if (hasPlan(task)) {
      clearLoop(sessionID)
      const ref = taskRef(task, task.path)
      const state: LoopState = {
        goal: taskGoal(task),
        stage: "plan",
        iteration: 0,
        paused: true,
        artifacts: { plan: extractPlan(task) ?? "" },
        task: ref,
      }
      setLoop(sessionID, state)
      const warning = wasInterrupted(task)
        ? " ⚠ A previous build looks interrupted — check git status/diff before approving."
        : ""
      await toast(
        client,
        `Plan already on file for "${task.title}" — review it, then /loop go to build.${warning}`,
        "info",
      )
      return
    }
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
  await toast(client, "Loop started — planning…", "info")
}
