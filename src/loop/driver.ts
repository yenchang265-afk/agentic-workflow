import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { slugify, type Task } from "../task/schema.ts"
import {
  appendNote,
  appendPlan,
  appendRunLog,
  auditNote,
  claimTask,
  extractPlan,
  findById,
  findByIdIn,
  hasPlan,
  isClaimable,
  isRecoverable,
  listByStatus,
  listInPlanning,
  listInProgress,
  moveTask,
  selectNext,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
  wasInterrupted,
  writeTask,
} from "../task/store.ts"
import {
  addWorktree,
  checkoutBranch,
  commitAll,
  commitPaths,
  currentBranch,
  ensureExcluded,
  gitActor,
  isDirty,
  isGitRepo,
  pruneWorktrees,
  removeWorktree,
  worktreeForBranch,
} from "./git.ts"
import { clearState, loadState, saveState } from "./persist.ts"
import { type Outcome, renderRunSummary, type StageSample } from "./metrics.ts"
import {
  failedCriteriaBlock,
  LOOP_REVIEW_TAG,
  LOOP_VERIFY_TAG,
  parseVerdict,
  type Verdict,
  type VerdictRecord,
  worstOf,
} from "./verdict.ts"
import type { Action, Config, LoopState, Stage, TaskRef } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  createState,
  findSessionDriving,
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
 * `in-progress/`; the loop finishing (review PASS) moves it to `in-review/`,
 * the human diff gate — a human moves it to `completed/` once it ships.
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
  | { readonly kind: "recover"; readonly task: Task }
  | { readonly kind: "recover-state"; readonly state: LoopState }
  | { readonly kind: "proceed" }

const pending = new Map<string, Pending>()
const driving = new Set<string>()
/** Sessions in `/loop watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()
/**
 * Working directories with a drive in flight. All sessions of one opencode
 * instance share a single working tree and checked-out branch, so at most one
 * loop may drive stages in it at a time — a second would switch branches out
 * from under the first. (Separate opencode processes on the same clone are
 * NOT covered — run extra watchers in their own clones/worktrees.)
 */
const executingDirs = new Set<string>()

/** A check stage's stage kind — the only stages that carry a verdict. */
type CheckStage = "verify" | "review"

/**
 * Verdicts recorded by the `loop_verdict` tool, per session, consumed by the
 * drive loop right after the check stage that recorded them completes. This
 * tool call — not the stage's free text — is the authoritative channel;
 * text is untrusted (quoted contracts, echoed repo content).
 */
const recordedVerdicts = new Map<string, { readonly stage: CheckStage; readonly verdict: Verdict }>()

/**
 * Record a verdict from the `loop_verdict` plugin tool. Only accepted while
 * this session's live loop is actually sitting in that check stage —
 * anything else (no loop, wrong stage, e.g. a build agent trying to
 * pre-empt its own verification) is ignored with an explanatory result.
 */
export const recordVerdict = (sessionID: string, stage: CheckStage, verdict: Verdict): string => {
  const state = getLoop(sessionID)
  if (!state) return "No active loop in this session — verdict ignored."
  if (state.stage !== stage) {
    return `The loop is at ${state.stage}, not ${stage} — verdict ignored. Only the running check stage may record its own verdict.`
  }
  recordedVerdicts.set(sessionID, { stage, verdict })
  return `Recorded ${stage} verdict: ${verdict}.`
}

/** Consume (read-and-clear) the verdict recorded for a session's check stage, if any. */
const takeVerdict = (sessionID: string, stage: CheckStage): Verdict | null => {
  const rec = recordedVerdicts.get(sessionID)
  recordedVerdicts.delete(sessionID)
  return rec && rec.stage === stage ? rec.verdict : null
}

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

/** A short stable id for branch names and checkpoint messages. */
const loopId = (state: LoopState): string => state.task?.id ?? (slugify(titleAndBody(state.goal).title) || "goal")

/** Absolute path to a task's dedicated worktree under the configured root. Pure. */
export const worktreePathFor = (directory: string, worktreesDir: string, id: string): string =>
  path.resolve(directory, worktreesDir, id)

/** Run the configured worktree-setup command in a fresh worktree. Warn-and-continue. */
const runWorktreeSetup = async (deps: Deps, config: Config, wtPath: string): Promise<void> => {
  if (!config.worktreeSetup) return
  const out = await deps.$`${{ raw: config.worktreeSetup }}`.cwd(wtPath).quiet().nothrow()
  if (out.exitCode !== 0) {
    await deps.log("warn", `loop: worktreeSetup failed in ${wtPath}: ${out.stderr.toString().trim()}`)
  }
}

/**
 * Isolate execution for this loop. Two modes:
 *
 * - **Worktree mode** (`config.worktreesDir` set): each loop gets its own
 *   `git worktree` on `loop/<id>`, cut from `base`. The human's checkout is
 *   never touched and concurrent drives are safe. If the worktree can't be
 *   created it **throws** — never falls back to shared-tree branch switching,
 *   which could clobber a concurrent drive's checked-out branch.
 * - **Shared-tree mode** (default): checks out `loop/<id>` in the main tree,
 *   as before. Degrades to no isolation (with a warning) outside a git repo,
 *   on a detached HEAD, or when checkout fails.
 *
 * An existing branch (e.g. a recovered run's) is reused, never reset.
 */
const ensureIsolation = async (deps: Deps, config: Config, state: LoopState): Promise<LoopState> => {
  if (state.git) {
    if (state.git.worktree) {
      // Worktree mode — never touch the shared tree. Recreate a vanished worktree.
      if (!(await isGitRepo(deps.$, state.git.worktree))) {
        await pruneWorktrees(deps.$, deps.directory)
        if (!(await addWorktree(deps.$, deps.directory, state.git.worktree, state.git.branch, state.git.base))) {
          throw new Error(`could not recreate worktree ${state.git.worktree} for ${state.git.branch}`)
        }
        await runWorktreeSetup(deps, config, state.git.worktree)
      }
      return state
    }
    // Shared mode — make sure the tree is back on this loop's branch.
    const cur = await currentBranch(deps.$, deps.directory)
    if (cur !== state.git.branch && !(await checkoutBranch(deps.$, deps.directory, state.git.branch))) {
      await deps.log("warn", `loop: could not return to ${state.git.branch} — building on ${cur ?? "detached HEAD"}`)
    }
    return state
  }

  if (!(await isGitRepo(deps.$, deps.directory))) return state
  const base = await currentBranch(deps.$, deps.directory)
  if (!base) {
    await deps.log("warn", "loop: detached HEAD — building without branch isolation")
    return state
  }
  const branch = `loop/${loopId(state)}`

  if (config.worktreesDir) {
    const wtPath = worktreePathFor(deps.directory, config.worktreesDir, loopId(state))
    await ensureExcluded(deps.$, deps.directory, config.worktreesDir)
    if (await isDirty(deps.$, deps.directory)) {
      await deps.log("info", "loop: main tree has uncommitted changes — they are NOT visible in this loop's worktree")
    }
    // Reuse a worktree already registered for this branch (a recovered run).
    const existing = await worktreeForBranch(deps.$, deps.directory, branch)
    if (existing) {
      if (existing !== wtPath) await deps.log("info", `loop: reusing existing worktree ${existing} for ${branch}`)
      return { ...state, git: { base, branch, worktree: existing } }
    }
    // A leftover directory with no registration — prune, then let add try.
    if (await isGitRepo(deps.$, wtPath)) await pruneWorktrees(deps.$, deps.directory)
    if (!(await addWorktree(deps.$, deps.directory, wtPath, branch, base))) {
      throw new Error(`could not create worktree ${wtPath} for ${branch} — resolve it, then /loop recover`)
    }
    await runWorktreeSetup(deps, config, wtPath)
    return { ...state, git: { base, branch, worktree: wtPath } }
  }

  if (await isDirty(deps.$, deps.directory)) {
    await deps.log(
      "warn",
      "loop: working tree dirty at build start — pre-existing changes will land in this loop's checkpoints",
    )
  }
  if (!(await checkoutBranch(deps.$, deps.directory, branch))) {
    await deps.log("warn", `loop: could not check out ${branch} — building without branch isolation`)
    return state
  }
  return { ...state, git: { base, branch } }
}

/** The working directory a loop's stages operate in: its worktree, else the main tree. */
const workTree = (deps: Deps, state: LoopState): string => state.git?.worktree ?? deps.directory

/** Commit everything as a checkpoint on the loop branch/worktree. No-op without isolation. */
const checkpoint = async (deps: Deps, state: LoopState, message: string): Promise<void> => {
  if (!state.git) return
  await commitAll(deps.$, workTree(deps, state), message)
}

/**
 * Tear down this loop's isolation. Worktree mode: remove the worktree if it's
 * clean (the branch is kept for human review); a dirty worktree or a failed
 * removal is left in place with a warning. Shared mode: return the main tree to
 * the branch it was on before the loop branched off.
 */
const teardownIsolation = async (deps: Deps, state: LoopState): Promise<void> => {
  if (!state.git) return
  if (state.git.worktree) {
    if (!(await removeWorktree(deps.$, deps.directory, state.git.worktree))) {
      await deps.log(
        "info",
        `loop: worktree ${state.git.worktree} left in place (dirty or locked) — branch ${state.git.branch} holds the committed work`,
      )
    }
    return
  }
  if (!(await checkoutBranch(deps.$, deps.directory, state.git.base))) {
    await deps.log("warn", `loop: could not return to ${state.git.base} — still on ${state.git.branch}`)
  }
}

/**
 * Commit backlog mutations (audit notes, task moves) on the MAIN tree. In
 * shared mode these ride the loop-branch checkpoints; in worktree mode the
 * checkpoints commit the worktree, so terminal-event backlog changes must be
 * committed on the human's branch explicitly. No-op in shared mode.
 */
const commitBacklog = async (deps: Deps, config: Config, state: LoopState, message: string): Promise<void> => {
  if (!state.git?.worktree) return
  await commitPaths(deps.$, deps.directory, [config.tasksDir], message)
}

/**
 * Fire a stage command and return the assistant text it produced. Throws when
 * the stage exceeds the configured wall-clock cap — a hung stage must fail
 * the loop (and release its locks via onIdle's catch) rather than wedge the
 * driver forever.
 */
const runStage = async (
  client: Client,
  sessionID: string,
  stage: string,
  args: string,
  timeoutMinutes: number,
): Promise<string> => {
  const command = client.session.command({
    path: { id: sessionID },
    body: { command: stage, arguments: args },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${stage} stage timed out after ${timeoutMinutes} minutes`)),
      timeoutMinutes * 60_000,
    )
  })
  try {
    const res = await Promise.race([command, timeout])
    const parts = res.data?.parts ?? []
    return parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
  } finally {
    clearTimeout(timer)
  }
}

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop. */
const drive = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  first: { state: LoopState; action: Action },
): Promise<void> => {
  const { client } = deps
  const actor = await gitActor(deps.$, deps.directory)
  let step = first
  while (step.action.kind === "fire") {
    const { stage, arguments: args } = step.action
    // Build runs isolated on its own loop/<id> branch (created on the first
    // build; re-checked-out on later ones in case the tree moved meanwhile).
    if (stage === "build") {
      step = { ...step, state: await ensureBranch(deps, step.state) }
    }
    setLoop(sessionID, step.state)
    const { task, iteration } = step.state
    const trackBuild = stage === "build" && task
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD started (iteration ${iteration + 1})`, new Date(), actor))
    recordedVerdicts.delete(sessionID) // no stale verdict may leak into this stage
    const output = await runStage(client, sessionID, stage, args, config.stageTimeoutMinutes)
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD finished (iteration ${iteration + 1})`, new Date(), actor))
    await appendRunLog(
      deps.$,
      deps.directory,
      config.tasksDir,
      loopId(step.state),
      `${stage} · iteration ${iteration + 1} · ${new Date().toISOString()}`,
      output,
    )
    // A /loop stop while the stage ran cleared this session's loop — halt the
    // chain, preserving whatever the stage did as a checkpoint on the branch.
    if (!getLoop(sessionID)) {
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): incomplete — stopped during ${stage}`)
      await restoreBase(deps, step.state)
      return
    }
    if (stage === "build") {
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): build iteration ${iteration + 1}`)
    }
    let verdict: Verdict | null = null
    if (stage === "verify" || stage === "review") {
      verdict = takeVerdict(sessionID, stage)
      if (verdict === null) {
        // The tool call is the only trusted channel. A text-only verdict is
        // logged for diagnosis but deliberately not honored.
        const inText = parseVerdict(output, stage === "verify" ? LOOP_VERIFY_TAG : LOOP_REVIEW_TAG)
        await deps.log(
          "warn",
          `${stage} recorded no verdict via loop_verdict${inText ? ` (text claimed ${inText})` : ""} — treating as FAIL`,
        )
      }
      if (task) {
        const recorded = verdict ?? "none recorded → FAIL"
        await appendNote(
          deps.$,
          task,
          auditNote(`${stage.toUpperCase()} verdict: ${recorded} (iteration ${iteration + 1})`, new Date(), actor),
        )
      }
    }
    step = advanceOnIdle(step.state, config, output, verdict)
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
          await appendNote(deps.$, state.task, auditNote("Plan recorded, awaiting approval", new Date(), actor))
          // Commit the exact plan text that will be approved — the durable
          // record of what the gate decision was about.
          await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${state.task.id}): plan recorded for approval`)
        } catch (err) {
          await deps.log("warn", `plan gated but persisting it failed: ${(err as Error).message}`)
        }
      }
      await toast(client, action.message, "info")
      return
    case "done": {
      // "Done" for the loop is not "completed" for the task: a human still
      // has to look at the diff. The task parks in in-review/; moving it to
      // completed/ (e.g. when the PR merges) is the human's call.
      if (state.task) {
        try {
          await appendNote(deps.$, state.task, auditNote("Loop done — review passed, awaiting human diff review", new Date(), actor))
          await moveTask(deps.$, state.task, "in-review")
          await commitBacklog(deps, config, state, `loop(${state.task.id}): done — parked in in-review`)
        } catch (err) {
          await deps.log("warn", `loop done but task move failed: ${(err as Error).message}`)
        }
      }
      await renderMetrics(deps, sessionID, config, state, "done", "review passed")
      await checkpoint(deps, state, `loop(${loopId(state)}): done — review passed`)
      await teardownIsolation(deps, state)
      if (state.task) await clearState(deps.$, deps.directory, config.tasksDir, state.task.id)
      clearLoop(sessionID)
      const where = state.git ? ` on branch ${state.git.branch}` : ""
      const next = state.task
        ? ` Review the diff${where}, then run /loop ship ${state.task.id} when it ships.`
        : where
          ? ` Review the diff${where}.`
          : ""
      await toast(client, `${action.message}${next}`, "success")
      return
    }
    case "stop": {
      // Per design: a failed/stopped task stays in-progress, annotated for a human.
      if (state.task) {
        await appendNote(deps.$, state.task, auditNote(action.message, new Date(), actor))
        await commitBacklog(deps, config, state, `loop(${state.task.id}): stopped — ${action.message}`)
      }
      await renderMetrics(deps, sessionID, config, state, "stopped", action.message)
      await checkpoint(deps, state, `loop(${loopId(state)}): incomplete — ${action.message}`)
      await teardownIsolation(deps, state)
      if (state.task) await clearState(deps.$, deps.directory, config.tasksDir, state.task.id)
      clearLoop(sessionID)
      const where = state.git ? ` Partial work is preserved on branch ${state.git.branch}.` : ""
      await toast(client, `${action.message}${where}`, "warning")
      return
    }
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
  const actor = await gitActor(deps.$, deps.directory)
  let id: string

  if (state.task) {
    try {
      await appendNote(deps.$, state.task, auditNote("Plan approved — parked for execution", new Date(), actor))
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
      await appendNote(deps.$, written, auditNote("Plan approved — parked for execution", new Date(), actor))
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

  // The approval record — who parked what — becomes a commit of its own.
  await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)

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
  // Atomic claim marker: only one watcher on this filesystem wins the task,
  // even when several saw it as claimable on the same idle tick.
  if (!(await claimTask(deps.$, task))) return
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
  // Serialize drives per working tree ONLY in shared-tree mode — there, two
  // loops would switch branches out from under each other. In worktree mode
  // each drive owns its own checkout, so concurrent drives are safe and the
  // lock is skipped (`ensureIsolation` throws rather than falling back to
  // shared-tree switching, so the main tree's HEAD is never touched).
  const serialize = !config.worktreesDir
  if (serialize && executingDirs.has(deps.directory)) return
  if (work) pending.delete(sessionID)
  driving.add(sessionID)
  if (serialize) executingDirs.add(deps.directory)
  try {
    if (work?.kind === "start") {
      await drive(deps, sessionID, config, firstStep(createState(work.goal)))
    } else if (work?.kind === "start-task") {
      const ref = taskRef(work.task, work.task.path)
      await drive(deps, sessionID, config, firstStep(createState(work.goal, ref)))
    } else if (work?.kind === "recover-state") {
      // A snapshot-based resume: re-enter at the exact stage the crash caught,
      // with artifacts intact. A paused-at-gate snapshot resumes the gate;
      // anything else re-fires its stage from its own inputs.
      const state = work.state
      const step = state.paused && state.stage === "plan" ? resume(state) : firstStep(state)
      await drive(deps, sessionID, config, step)
    } else if (work?.kind === "recover") {
      // A human-forced resume of a started-but-dead task with no valid snapshot:
      // re-enter the state machine at build with the persisted plan.
      const ref = taskRef(work.task, work.task.path)
      const state = resumeAtBuild(taskGoal(work.task), ref, extractPlan(work.task) ?? "")
      await drive(deps, sessionID, config, firstStep(state))
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
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(`Loop error: ${message}`, new Date(), await gitActor(deps.$, deps.directory)),
      )
    }
    // Preserve whatever the failed run left behind and put the tree back.
    if (state) {
      await renderMetrics(deps, sessionID, config, state, "error", message)
      if (state.task) await commitBacklog(deps, config, state, `loop(${state.task.id}): loop error — ${message}`)
      await checkpoint(deps, state, `loop(${loopId(state)}): incomplete — loop error`)
      await teardownIsolation(deps, state)
    } else {
      runSamples.delete(sessionID)
    }
    clearLoop(sessionID)
    await toast(deps.client, `Loop error: ${message}`, "error")
  } finally {
    driving.delete(sessionID)
    if (serialize) executingDirs.delete(deps.directory)
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
        auditNote(
          `Loop stopped by /loop stop — was at ${state.stage} (iteration ${state.iteration + 1}).`,
          new Date(),
          await gitActor(deps.$, deps.directory),
        ),
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

  if (lower === "recover" || lower.startsWith("recover ")) {
    const id = arg.slice("recover".length).trim()
    if (!id) return void (await toast(client, "Usage: /loop recover <id>.", "warning"))
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) return void (await toast(client, `No in-progress task "${id}".`, "warning"))
    const driving = findSessionDriving(id)
    if (driving) {
      return void (await toast(client, `Task "${id}" is being driven by a live loop — nothing to recover.`, "warning"))
    }
    if (isClaimable(task)) {
      return void (await toast(client, `Task "${id}" was never started — /loop watch will claim it.`, "info"))
    }
    if (!isRecoverable(task)) {
      return void (await toast(client, `Task "${id}" has no persisted plan — move it back to in-planning and re-run /loop task ${id}.`, "warning"))
    }
    await claimTask(deps.$, task) // re-mark; the marker may already exist from the dead run
    // Prefer an exact-stage resume from the state snapshot; fall back to
    // re-entering at BUILD from the persisted plan when there's no valid one.
    const snap = await loadState(client, deps.directory, config.tasksDir, id)
    const actor = await gitActor(deps.$, deps.directory)
    clearLoop(sessionID)
    if (snap && snap.task?.id === id) {
      // Refresh the task path from disk — the file may have moved since the snapshot.
      const state: LoopState = { ...snap, task: { ...snap.task, path: task.path } }
      await appendNote(
        deps.$,
        task,
        auditNote(`Recovered by /loop recover — resuming from snapshot at ${snap.stage}.`, new Date(), actor),
      )
      pending.set(sessionID, { kind: "recover-state", state })
      await toast(
        client,
        `Recovering "${task.title}" from snapshot at ${snap.stage} — check git status/diff for leftovers; resuming…`,
        "info",
      )
      return
    }
    await appendNote(
      deps.$,
      task,
      auditNote("Recovered by /loop recover — resuming BUILD from the persisted plan.", new Date(), actor),
    )
    pending.set(sessionID, { kind: "recover", task })
    await toast(
      client,
      `Recovering "${task.title}" — check git status/diff for leftovers from the interrupted run; building…`,
      "info",
    )
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
