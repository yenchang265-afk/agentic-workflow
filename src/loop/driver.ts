import type { PluginInput } from "@opencode-ai/plugin"
import type { Task } from "../task/schema.ts"
import {
  appendNote,
  appendPlan,
  extractPlan,
  findById,
  hasPlan,
  isClaimable,
  listInPlanning,
  listInProgress,
  moveTask,
  selectNext,
  wasInterrupted,
  writeTask,
} from "../task/store.ts"
import type { Action, Config, LoopState, TaskRef } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  createState,
  firstStep,
  getLoop,
  resume,
  resumeAtBuild,
  resumeAtPlanGate,
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
 * A free-text `/loop <goal>` doesn't queue a `start` directly — it parks a
 * `clarify` marker instead, which `onIdle` treats as inert. The `/loop`
 * command's own prompt decides live, in that turn, whether the goal needs an
 * `interview-me` pass; either way it only queues the actual `start` by
 * calling the `loop_begin` plugin tool (see `index.ts`), which promotes the
 * marker via `beginAfterClarification`. This keeps that skill's live-user
 * requirement out of the unattended stage loop entirely — nothing is queued
 * until a human turn explicitly calls `loop_begin`.
 *
 * PLAN is the **planning phase** — fully interactive, one session.
 * Approving the plan gate for the first time (`state.iteration ===
 * 0`) does **not** continue into BUILD in this session anymore — it **parks**
 * the approved plan as a durable task in `in-progress/` (`parkApprovedPlan`).
 * A task-driven loop's plan is already on disk from the gate, so parking
 * just moves the file; a free-text loop is promoted into a real task file
 * for the first time, via the same `writeTask` primitive `task-author` uses.
 * Either way the approving session's `LoopState` is cleared — its job is done.
 *
 * BUILD → VERIFY → REVIEW is the **execution phase**, run by a separate
 * `/loop watch` session (the `watching` set + `tryClaim`), not the planning
 * session. On every idle tick, a watching session with nothing else to do
 * scans `in-progress/` for one claimable task (`isClaimable`: has a
 * persisted plan, never started) and, if found, claims it — appending the
 * same "BUILD started" note `drive()` already writes is the claim, with no
 * separate lock — and drives it via `resumeAtBuild`, entering the shared
 * state machine directly at `build`. A VERIFY FAIL or REVIEW FAIL loops back
 * to `plan`/`build` **inside this same watch session**; re-plans/re-builds
 * are never handed back to a separate planning session. A plan gate reached
 * that way (`iteration > 0`) still resumes in-session on `/loop go`, since by
 * then the task is already parked and mid-execution — only the *first*
 * approval parks. Two watch sessions racing the same idle tick could both see
 * a task as claimable before either claims it; accepted, not engineered
 * around, same as this codebase's other best-effort-filesystem risks.
 *
 * A task starts the loop already sitting in `in-planning/` — moving it there
 * from `draft/` is the first human gate. The driver moves it once more
 * automatically, to `in-progress/`, the moment its plan is approved (see
 * above); a stop/failure while building appends a note and leaves it in
 * `in-progress/`; the loop finishing (review PASS) moves it to `completed/`.
 * The first time a task's plan gates for approval, it is also persisted onto
 * the task file (`## Implementation Plan`), so `/loop next` can skip
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
  | { readonly kind: "clarify"; readonly rawGoal: string }
  | { readonly kind: "start"; readonly goal: string }
  | { readonly kind: "start-task"; readonly task: Task; readonly goal: string }
  | { readonly kind: "proceed" }

const pending = new Map<string, Pending>()
const driving = new Set<string>()
/** Sessions in `/loop watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()

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
      // The plan→build gate persists onto the task file, only the first
      // time (iteration 0) — re-plans thread the prior plan via the artifact
      // instead.
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

/** Derive a title (first line, truncated) and body (the rest) from a
 *  free-text goal, for promoting it into a task file at approval time. */
const titleAndBody = (goal: string): { title: string; body: string } => {
  const [first = "", ...rest] = goal.split("\n")
  const trimmed = first.trim() || "Loop task"
  const title = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
  return { title, body: rest.join("\n").trim() }
}

/**
 * Park an approved plan (first approval only — `state.iteration === 0`) as a
 * durable backlog record instead of continuing into BUILD in this session. A
 * `/loop watch` session claims it later (see `tryClaim`). A task-driven loop
 * already has the plan persisted on disk from the gate — just move the file.
 * A free-text loop has nothing durable yet; promote it into a real task file
 * now, via the same `writeTask` primitive `task-author` uses.
 */
const parkApprovedPlan = async (
  deps: Deps,
  sessionID: string,
  state: LoopState,
  config: Config,
): Promise<void> => {
  const plan = state.artifacts.plan ?? ""
  let id: string

  if (state.task) {
    try {
      await moveTask(deps.$, state.task, "in-progress")
    } catch (err) {
      await deps.log("warn", `plan approved but parking failed: ${(err as Error).message}`)
    }
    id = state.task.id
  } else {
    const { title, body } = titleAndBody(state.goal)
    try {
      const written = await writeTask(
        deps.$,
        deps.client,
        { directory: deps.directory, tasksDir: config.tasksDir, status: "in-progress" },
        { title, body },
      )
      await appendPlan(deps.$, written, plan)
      id = written.id
    } catch (err) {
      const message = (err as Error).message
      await deps.log("warn", `plan approved but parking a free-text goal failed: ${message}`)
      // Leave the session's LoopState as-is (still paused at the gate) so a
      // human can just run /loop go again to retry, instead of losing the plan.
      await toast(deps.client, `Could not park the approved plan: ${message}. Run /loop go to retry.`, "error")
      return
    }
  }

  clearLoop(sessionID)
  await toast(
    deps.client,
    `Plan approved — parked as "${id}" in ${config.tasksDir}/in-progress/. Run /loop watch in another session to build it.`,
    "success",
  )
}

/**
 * A `/loop watch` session's own idle check: look for one claimable task in
 * `in-progress/` (planned, never started) and, if found, drive it straight
 * through BUILD → VERIFY → REVIEW. FAIL-driven re-plans/re-builds happen
 * inline in this same session, exactly like a normal loop's iteration cap.
 */
const tryClaim = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  const tasks = await listInProgress(deps.client, deps.directory, config.tasksDir, deps.log)
  const task = selectNext(tasks.filter(isClaimable))
  if (!task) return // nothing ready; try again next idle tick
  const ref = taskRef(task, task.path)
  const state = resumeAtBuild(taskGoal(task), ref, extractPlan(task) ?? "")
  await toast(deps.client, `Watch: claimed "${task.title}" — building…`, "info")
  await drive(deps, sessionID, config, firstStep(state))
}

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  if (driving.has(sessionID)) return
  const work = pending.get(sessionID)
  // Still being clarified (possibly mid-interview) — nothing to drive until
  // the command's own turn calls loop_begin. Leave the marker in place.
  if (work?.kind === "clarify") return
  // Nothing to do unless there's real pending work, or this is an idle
  // watch session with no loop of its own currently running.
  const shouldWatch = watching.has(sessionID) && !getLoop(sessionID)
  if (!work && !shouldWatch) return
  if (work) pending.delete(sessionID)
  driving.add(sessionID)
  try {
    if (work?.kind === "start") {
      await drive(deps, sessionID, config, firstStep(createState(work.goal)))
    } else if (work?.kind === "start-task") {
      const ref = taskRef(work.task, work.task.path)
      await drive(deps, sessionID, config, firstStep(createState(work.goal, ref)))
    } else if (work?.kind === "proceed") {
      const state = getLoop(sessionID)
      if (state?.paused && state.stage === "plan") {
        if (state.iteration === 0) {
          await parkApprovedPlan(deps, sessionID, state, config)
        } else {
          // A VERIFY-FAIL re-plan gate reached mid-execution (the task is
          // already parked and past its first approval) — stays in this
          // session, same as today.
          let next = state
          if (state.task) {
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
    } else {
      // No pending work — a watch session with nothing to resume; look for
      // one claimable task in the backlog.
      await tryClaim(deps, sessionID, config)
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

/**
 * Promote a parked `clarify` marker to `start`, once the `/loop <goal>`
 * command's own turn has decided the goal is ready — either judged
 * unambiguous outright, or confirmed via a live `interview-me` exchange.
 * Called from the `loop_begin` plugin tool (see `index.ts`), never from
 * inside the automatic stage loop.
 */
export const beginAfterClarification = async (deps: Deps, sessionID: string, goal: string): Promise<string> => {
  const work = pending.get(sessionID)
  if (!work || work.kind !== "clarify") {
    return "No goal is awaiting clarification for this session — nothing to start."
  }
  const trimmed = goal.trim()
  if (!trimmed) return "Refusing to start a loop with an empty goal."
  pending.set(sessionID, { kind: "start", goal: trimmed })
  await toast(deps.client, "Loop started — planning…", "info")
  return `Loop queued for: ${trimmed}`
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
    const message = state.iteration === 0 ? "Approved — parking for execution…" : "Approved — building…"
    await toast(client, message, "info")
    return
  }

  if (lower === "stop" || lower === "abort") {
    const wasClarifying = pending.get(sessionID)?.kind === "clarify"
    const wasWatching = watching.delete(sessionID)
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
    const message = existed
      ? "Loop stopped."
      : wasClarifying
        ? "Clarification cancelled."
        : wasWatching
          ? "Stopped watching."
          : "No active loop to stop."
    await toast(client, message, "info")
    return
  }

  if (lower === "watch") {
    watching.add(sessionID)
    await toast(client, "Watching for approved tasks to build.", "info")
    return
  }

  if (lower === "unwatch") {
    const was = watching.delete(sessionID)
    await toast(client, was ? "Stopped watching." : "Not watching.", "info")
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
      const state = resumeAtPlanGate(taskGoal(task), ref, extractPlan(task) ?? "")
      setLoop(sessionID, state)
      const warning = wasInterrupted(task)
        ? " ⚠ A previous build looks interrupted — check git status/diff before approving."
        : ""
      await toast(
        client,
        `Plan already on file for "${task.title}" — review it, then /loop go to approve and park it for execution.${warning}`,
        "info",
      )
      return
    }
    await queueTask(deps, sessionID, task)
    return
  }

  if (lower === "status" || lower === "") {
    const isWatching = watching.has(sessionID)
    const state = getLoop(sessionID)
    if (!state) {
      const clarifying = pending.get(sessionID)
      const message =
        clarifying?.kind === "clarify"
          ? `Loop pending — clarifying "${clarifying.rawGoal}" (answer above, or /loop stop to cancel).`
          : isWatching
            ? "Watching — no claimable task right now."
            : "No active loop."
      await toast(client, message, "info")
      return
    }
    const where = state.paused ? `${state.stage} (paused at gate)` : state.stage
    const what = state.task ? `task ${state.task.id}` : state.goal
    const prefix = isWatching ? "Watching. " : ""
    await toast(client, `${prefix}Loop: ${where} · iteration ${state.iteration + 1} · ${what}`, "info")
    return
  }

  // Anything else is a free-text goal → park it for clarification (replacing
  // any existing loop). The command's own prompt decides whether it needs an
  // interview-me pass, then calls loop_begin to actually queue the start.
  clearLoop(sessionID)
  pending.set(sessionID, { kind: "clarify", rawGoal: arg })
}
