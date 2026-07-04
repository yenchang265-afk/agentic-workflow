import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { slugify, type Task } from "../task/schema.ts"
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
  findSessionDriving,
  firstStep,
  getLoop,
  resumeAtBuild,
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
 * Planning happens **before** the loop, in the `/loop-plan` command:
 * `new <idea>` interviews the user into a planless draft, `task <id>` moves the
 * draft to `in-planning/` (plugin-side, in `handlePlanCommand`) and has the
 * agent write the `## Implementation Plan` in place, and the deterministic
 * `/loop-plan approve <id>` subcommand validates the plan and parks the task in
 * `in-progress/` — the approved queue. The loop itself is a pure executor: it
 * never plans, and every state enters at `build` via `resumeAtBuild` with the
 * approved plan threaded in as an artifact.
 *
 * BUILD → VERIFY → REVIEW runs either on demand (`/loop task <id>` claims one
 * approved task) or via **watch mode** (the `watching` set + `tryClaim`): a
 * watching session scans `in-progress/` for one claimable task (`isClaimable`:
 * has a persisted plan, never started) and, if found, claims it and drives it.
 * Watch is triggered two ways — every `session.idle` event, plus a per-session
 * interval timer (`/loop watch [interval]`) whose ticks call `onIdle` only when
 * the session is actually idle (queried via `client.session.status()`), so a
 * task approved while the session sat quiet still gets picked up. A VERIFY or
 * REVIEW FAIL loops back to `build` **inside this same session**, with the
 * failure threaded into the build prompt. Two watch sessions racing the same
 * tick could both see a task as claimable before either claims it; the atomic
 * `claimTask` marker resolves the race.
 *
 * Task lifecycle: `/loop-plan` authors into `in-planning/` (or plans a `draft/`
 * stub in place); `/loop-plan approve <id>` moves it to `in-progress/`; a
 * stop/failure while building appends a note and leaves it in `in-progress/`;
 * the loop finishing (review PASS) moves it to `in-review/`, the human diff
 * gate — a human runs `/loop ship <id>` to move it to `completed/`. If the
 * plan itself turns out wrong (the iteration cap stops the loop), a human
 * re-plans with `/loop-plan task <id>`.
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
  | { readonly kind: "start-task"; readonly task: Task; readonly goal: string }
  | { readonly kind: "recover"; readonly task: Task }
  | { readonly kind: "recover-state"; readonly state: LoopState }

const pending = new Map<string, Pending>()
const driving = new Set<string>()
/** Sessions in `/loop watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()
/** Per-watching-session polling timers and their cadence (for status display). */
const watchTimers = new Map<string, ReturnType<typeof setInterval>>()
const watchIntervalsMs = new Map<string, number>()
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
const recordedVerdicts = new Map<string, { readonly stage: CheckStage; readonly record: VerdictRecord }>()

/** Per-session run metrics, accumulated across a drive and rendered on termination. */
const runSamples = new Map<string, StageSample[]>()

/** Append a stage sample to this session's run metrics. */
const addSample = (sessionID: string, sample: StageSample): void => {
  const list = runSamples.get(sessionID) ?? []
  list.push(sample)
  runSamples.set(sessionID, list)
}

/**
 * Record a verdict from the `loop_verdict` plugin tool. Only accepted while
 * this session's live loop is actually sitting in that check stage —
 * anything else (no loop, wrong stage, e.g. a build agent trying to
 * pre-empt its own verification) is ignored with an explanatory result.
 * The optional `reason`/`criteria` steer the next iteration's prompt only.
 */
export const recordVerdict = (sessionID: string, stage: CheckStage, record: VerdictRecord): string => {
  const state = getLoop(sessionID)
  if (!state) return "No active loop in this session — verdict ignored."
  if (state.stage !== stage) {
    return `The loop is at ${state.stage}, not ${stage} — verdict ignored. Only the running check stage may record its own verdict.`
  }
  recordedVerdicts.set(sessionID, { stage, record })
  return `Recorded ${stage} verdict: ${record.verdict}.`
}

/** Consume (read-and-clear) the verdict record for a session's check stage, if any. */
const takeVerdictRecord = (sessionID: string, stage: CheckStage): VerdictRecord | null => {
  const rec = recordedVerdicts.get(sessionID)
  recordedVerdicts.delete(sessionID)
  return rec && rec.stage === stage ? rec.record : null
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

/** A short stable id for branch names and checkpoint messages. Every loop is
 *  task-driven now; the goal-derived slug is a defensive fallback only. */
const loopId = (state: LoopState): string => state.task?.id ?? (slugify(state.goal.split("\n")[0] ?? "") || "goal")

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

/**
 * Combine the verdict records of several review-lens passes into one: the worst
 * verdict wins, and the reasons/failed-criteria of every non-PASS pass are
 * merged so the re-build prompt sees all objections. Pure.
 */
const combineRecords = (records: readonly (VerdictRecord | null)[], lenses: readonly string[]): VerdictRecord => {
  const verdict = worstOf(records.map((r) => r?.verdict ?? null))
  const reasons: string[] = []
  const criteria: { criterion: string; pass: boolean }[] = []
  records.forEach((r, i) => {
    if (!r || r.verdict === "PASS") return
    const lens = lenses[i]
    if (r.reason) reasons.push(lens ? `[${lens}] ${r.reason}` : r.reason)
    for (const c of r.criteria ?? []) criteria.push(c)
  })
  return {
    verdict,
    ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
    ...(criteria.length ? { criteria } : {}),
  }
}

/**
 * Fire a stage, log its output to the run log, and (for check stages) capture
 * its verdict record. REVIEW expands into one pass per configured lens — the
 * verdicts are combined worst-wins and non-PASS pass outputs concatenated, so
 * a single injected reviewer can't flip the outcome (threat model T1). All
 * other stages run exactly once. Stops firing further lens passes if a
 * `/loop stop` clears the loop mid-pass.
 */
const runStageWithLenses = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  state: LoopState,
  stage: Stage,
  baseArgs: string,
  iteration: number,
): Promise<{ output: string; verdict: Verdict | null; record: VerdictRecord | null }> => {
  const isCheck = stage === "verify" || stage === "review"
  const lenses = stage === "review" ? config.reviewLenses : []
  const passes: (string | null)[] = lenses.length ? [...lenses] : [null]
  const outputs: string[] = []
  const records: (VerdictRecord | null)[] = []
  const { client } = deps

  for (let i = 0; i < passes.length; i++) {
    const lens = passes[i]
    const args = lens
      ? `${baseArgs}\n\nReview lens ${i + 1}/${passes.length}: focus exclusively on ${lens}. The other lenses ` +
        `run as separate passes — don't repeat them. Record this pass's verdict via loop_verdict as usual.`
      : baseArgs
    recordedVerdicts.delete(sessionID) // no stale verdict may leak into this pass
    const t0 = Date.now()
    const out = await runStage(client, sessionID, stage, args, config.stageTimeoutMinutes)
    const ms = Date.now() - t0
    const stamp = new Date().toISOString()
    const header = lens
      ? `${stage} (lens: ${lens}) · iteration ${iteration + 1} · ${stamp}`
      : `${stage} · iteration ${iteration + 1} · ${stamp}`
    await appendRunLog(deps.$, deps.directory, config.tasksDir, loopId(state), header, out, deps.log)
    outputs.push(lens ? `### Review lens: ${lens}\n${out}` : out)
    const passRecord = isCheck ? takeVerdictRecord(sessionID, stage as CheckStage) : null
    records.push(passRecord)
    addSample(sessionID, {
      stage,
      iteration,
      ms,
      ...(isCheck ? { verdict: passRecord?.verdict ?? "none" } : {}),
      ...(lens ? { lens } : {}),
    })
    if (!getLoop(sessionID)) break // /loop stop mid-pass — don't fire the rest
  }

  if (!isCheck) return { output: outputs[0] ?? "", verdict: null, record: null }

  const record = lenses.length ? combineRecords(records, lenses) : (records[0] ?? null)
  const verdict = record?.verdict ?? null
  if (verdict === null) {
    const inText = parseVerdict(outputs.join("\n"), stage === "verify" ? LOOP_VERIFY_TAG : LOOP_REVIEW_TAG)
    await deps.log(
      "warn",
      `${stage} recorded no verdict via loop_verdict${inText ? ` (text claimed ${inText})` : ""} — treating as FAIL`,
    )
  }
  return { output: outputs.join("\n\n"), verdict, record }
}

/**
 * Persist a task-driven loop's state after a transition, so a crash/restart can
 * resume at the exact stage. No-op for free-text loops (no durable id yet).
 */
const snapshot = async (deps: Deps, config: Config, state: LoopState): Promise<void> => {
  if (!state.task) return
  await saveState(deps.$, deps.directory, config.tasksDir, state.task.id, state)
}

/**
 * Render this session's accumulated run metrics into the run log and clear the
 * accumulator. Called once per terminal event (done/stop/error). Best-effort —
 * never let telemetry failure disrupt the terminal handling.
 */
const renderMetrics = async (
  deps: Deps,
  sessionID: string,
  config: Config,
  state: LoopState,
  outcome: Outcome,
  detail: string,
): Promise<void> => {
  const samples = runSamples.get(sessionID) ?? []
  runSamples.delete(sessionID)
  const summary = renderRunSummary(samples, outcome, detail, config.maxIterations, new Date().toISOString())
  await appendRunLog(deps.$, deps.directory, config.tasksDir, loopId(state), `run · ${outcome}`, summary, deps.log)
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
    // Every stage runs isolated: its own worktree (worktree mode) or the
    // loop/<id> branch in the shared tree (default). Created on the first build;
    // reconciled before every stage in case the tree/worktree moved — including
    // a snapshot-based `/loop recover` that re-enters directly at verify/review,
    // where isolation must be re-established, not assumed.
    step = { ...step, state: await ensureIsolation(deps, config, step.state) }
    setLoop(sessionID, step.state)
    await snapshot(deps, config, step.state)
    const { task, iteration } = step.state
    const trackBuild = stage === "build" && task
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD started (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    const { output, verdict, record } = await runStageWithLenses(
      deps,
      sessionID,
      config,
      step.state,
      stage,
      args,
      iteration,
    )
    if (trackBuild) await appendNote(deps.$, task, auditNote(`BUILD finished (iteration ${iteration + 1})`, new Date(), actor), deps.log)
    // A /loop stop while the stage ran cleared this session's loop — halt the
    // chain, preserving whatever the stage did as a checkpoint on the branch.
    if (!getLoop(sessionID)) {
      await renderMetrics(deps, sessionID, config, step.state, "stopped", `stopped during ${stage}`)
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): incomplete — stopped during ${stage}`)
      await teardownIsolation(deps, step.state)
      // A deliberate /loop stop ends the run — drop the snapshot so a later
      // /loop recover doesn't silently resurrect it from stale state.
      if (step.state.task) await clearState(deps.$, deps.directory, config.tasksDir, step.state.task.id)
      return
    }
    if (stage === "build") {
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): build iteration ${iteration + 1}`)
    }
    if ((stage === "verify" || stage === "review") && task) {
      const failed = record?.criteria?.filter((c) => !c.pass).length ?? 0
      const detail = record?.reason ? ` — ${record.reason}` : ""
      const criteriaNote = failed ? ` (${failed} criteria unmet)` : ""
      await appendNote(
        deps.$,
        task,
        auditNote(
          `${stage.toUpperCase()} verdict: ${verdict ?? "none recorded → FAIL"}${criteriaNote}${detail} (iteration ${iteration + 1})`,
          new Date(),
          actor,
        ),
        deps.log,
      )
    }
    // Thread the machine-recorded failure reasons ahead of the stage's prose so
    // the next PLAN/BUILD iteration leads with what actually failed.
    const block = failedCriteriaBlock(record)
    const threaded = block ? `${block}\n\n${output}` : output
    step = advanceOnIdle(step.state, config, threaded, verdict)
  }

  const { state, action } = step
  switch (action.kind) {
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

/** Which status folder a task id currently lives in, or null. For error messages. */
const findAnyStatus = async (deps: Deps, config: Config, id: string): Promise<TaskStatus | null> => {
  for (const status of STATUSES) {
    if (await findByIdIn(deps.client, deps.directory, config.tasksDir, status, id)) return status
  }
  return null
}

/** Load every status folder and roll it up. One list call per folder. */
const backlogSummary = async (deps: Deps, config: Config) => {
  const byStatus = {} as Record<TaskStatus, Task[]>
  for (const status of STATUSES) {
    byStatus[status] = await listByStatus(deps.client, deps.directory, config.tasksDir, status, deps.log)
  }
  return summarizeBacklog(byStatus)
}

/** Human-readable one-liner of the backlog roll-up. Pure. */
const formatBacklog = (s: Awaited<ReturnType<typeof backlogSummary>>): string => {
  const c = s.counts
  const planning =
    c["in-planning"] > 0 ? `${c["in-planning"]} planning (${s.gated.length} awaiting approval)` : "0 planning"
  const progress =
    c["in-progress"] > 0
      ? `${c["in-progress"]} in-progress (${s.claimable.length} ready, ${s.interrupted.length} interrupted)`
      : "0 in-progress"
  return `backlog: ${c.draft} draft · ${planning} · ${progress} · ${c["in-review"]} in-review · ${c.completed} completed · ${c.abandoned} abandoned`
}

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  if (driving.has(sessionID)) return
  const work = pending.get(sessionID)
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
    if (work?.kind === "start-task" || work?.kind === "recover") {
      // `start-task`: a `/loop task <id>` claim entering execution at build.
      // `recover`: a human-forced resume of a started-but-dead task with no
      // valid snapshot. Both re-enter the state machine at build with the
      // persisted plan.
      const ref = taskRef(work.task, work.task.path)
      const state = resumeAtBuild(taskGoal(work.task), ref, extractPlan(work.task) ?? "")
      await drive(deps, sessionID, config, firstStep(state))
    } else if (work?.kind === "recover-state") {
      // A snapshot-based resume: re-enter at the exact stage the crash caught,
      // with artifacts intact, re-firing that stage from its own inputs.
      await drive(deps, sessionID, config, firstStep(work.state))
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

/** Human-readable rendering of a polling cadence in ms. Pure. */
const formatInterval = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`

/** Minimum watch polling cadence — anything tighter just burns idle queries. */
const MIN_WATCH_INTERVAL_MS = 10_000

/**
 * Parse the interval spec of `/loop watch [interval]`. Accepts `""` (use the
 * config default), `30s`, `5m`, `2h`, a bare number (minutes), and an
 * optional `--interval ` prefix. Clamped to at least 10 seconds. Pure.
 */
export const parseWatchArgs = (spec: string): { intervalMs?: number } | { error: string } => {
  const s = spec.trim().replace(/^--interval\s+/i, "")
  if (!s) return {}
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(s)
  if (!m || Number(m[1]) <= 0) {
    return { error: `Unrecognized watch interval "${spec.trim()}" — use e.g. 30s, 5m, 2h, or a bare number of minutes.` }
  }
  const value = Number(m[1])
  const unit = (m[2] ?? "").toLowerCase() || "m"
  const ms = value * (unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000)
  return { intervalMs: Math.max(ms, MIN_WATCH_INTERVAL_MS) }
}

/** Clear one session's watch polling timer, if any. */
const stopWatchTimer = (sessionID: string): void => {
  const timer = watchTimers.get(sessionID)
  if (timer) clearInterval(timer)
  watchTimers.delete(sessionID)
  watchIntervalsMs.delete(sessionID)
}

/** Clear every watch timer — called from the plugin's dispose hook. */
export const disposeWatch = (): void => {
  for (const timer of watchTimers.values()) clearInterval(timer)
  watchTimers.clear()
  watchIntervalsMs.clear()
}

/**
 * One watch-timer tick: claim work only when this session is genuinely quiet.
 * The `session.idle` event path stays the fast trigger; the timer exists for
 * the case that path misses — a task approved (by `/loop-plan approve` in
 * another session) while this session sat idle generating no new events.
 * Idleness is queried, not tracked: absent from the status map counts as idle.
 * Never throws — an unhandled rejection inside a timer would crash the host.
 */
const watchTick = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  try {
    if (!watching.has(sessionID) || driving.has(sessionID) || getLoop(sessionID)) return
    const res = await deps.client.session.status().catch(() => null)
    const status = res?.data?.[sessionID]
    if (status && status.type !== "idle") return
    await onIdle(deps, sessionID, config)
  } catch (err) {
    await deps.log("warn", `loop: watch tick failed: ${(err as Error).message}`)
  }
}

/** Parsed `/loop-plan` arguments: which subcommand needs plugin work, if any. */
export type PlanArgs = { mode: "approve" | "task"; id: string } | { mode: "passthrough" }

/**
 * Classify `/loop-plan` arguments. `approve <id>` and `task <id>` get
 * deterministic plugin work before the agent turn; everything else (including
 * `new <idea>`) passes through untouched. An empty id is preserved so the
 * caller can toast a usage hint.
 */
export const parsePlanArgs = (args: string): PlanArgs => {
  const arg = args.trim()
  const lower = arg.toLowerCase()
  for (const mode of ["approve", "task"] as const) {
    if (lower === mode || lower.startsWith(`${mode} `)) {
      return { mode, id: arg.slice(mode.length).trim() }
    }
  }
  return { mode: "passthrough" }
}

/**
 * Handle a `/loop-plan ...` command. Two subcommands get deterministic plugin
 * work before the agent turn; `new <idea>` passes through untouched (its
 * authoring — interview, draft — is the agent's job, see
 * `.opencode/commands/loop-plan.md`):
 *
 * - `task <id>` — if the task sits in `draft/`, move it to `in-planning/`
 *   (audited + committed) so folder semantics stay honest: `draft/` means no
 *   planning attempted, `in-planning/` means planning started or done. The
 *   agent then writes the `## Implementation Plan` onto the file in place.
 *   Failures never block the turn — the agent also looks in `draft/`.
 * - `approve <id>` — deterministic backlog surgery: validate the plan exists
 *   and park the task in `in-progress/` (the approved queue).
 */
export const handlePlanCommand = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const parsed = parsePlanArgs(args)
  if (parsed.mode === "passthrough") return
  const { id } = parsed
  if (parsed.mode === "task") {
    if (!id) return void (await toast(client, "Usage: /loop-plan task <id>.", "warning"))
    if (await findByIdIn(client, deps.directory, config.tasksDir, "in-planning", id)) return
    const draft = await findByIdIn(client, deps.directory, config.tasksDir, "draft", id)
    if (!draft) {
      return void (await toast(client, `No draft/in-planning task "${id}" found — the agent will report what it sees.`, "warning"))
    }
    try {
      const actor = await gitActor(deps.$, deps.directory)
      await appendNote(deps.$, draft, auditNote("Planning started — moved to in-planning", new Date(), actor))
      await moveTask(deps.$, draft, "in-planning")
      await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): planning started`)
      await toast(client, `"${draft.title}" moved to ${config.tasksDir}/in-planning/ — the plan will be written there.`, "success")
    } catch (err) {
      await toast(client, `Couldn't move "${id}" to in-planning: ${(err as Error).message} — planning continues in draft/.`, "error")
    }
    return
  }
  if (!id) return void (await toast(client, "Usage: /loop-plan approve <id>.", "warning"))
  const task =
    (await findByIdIn(client, deps.directory, config.tasksDir, "in-planning", id)) ??
    (await findByIdIn(client, deps.directory, config.tasksDir, "draft", id))
  if (!task) {
    const elsewhere = await findAnyStatus(deps, config, id)
    const detail = elsewhere
      ? `it's in ${elsewhere} — only draft/in-planning tasks can be approved`
      : `no task "${id}" found`
    return void (await toast(client, `Can't approve "${id}": ${detail}.`, "warning"))
  }
  if (!hasPlan(task)) {
    return void (await toast(client, `Task "${id}" has no Implementation Plan yet — run /loop-plan task ${id} first.`, "warning"))
  }
  try {
    const actor = await gitActor(deps.$, deps.directory)
    await appendNote(deps.$, task, auditNote("Plan approved — parked for execution", new Date(), actor))
    await moveTask(deps.$, task, "in-progress")
    await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
    await toast(
      client,
      `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/. /loop watch (or /loop task ${id}) will build it.`,
      "success",
    )
  } catch (err) {
    await toast(client, `Approve failed for "${id}": ${(err as Error).message}`, "error")
  }
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

  if (lower === "go" || lower === "approve" || lower.startsWith("approve ")) {
    await toast(
      client,
      "The plan gate moved: approve plans with /loop-plan approve <id>. The loop only executes approved tasks.",
      "warning",
    )
    return
  }

  if (lower === "next") {
    await toast(
      client,
      "/loop next was removed — author and approve a plan with /loop-plan, then /loop task <id> or /loop watch.",
      "warning",
    )
    return
  }

  if (lower === "stop" || lower === "abort") {
    const wasWatching = watching.delete(sessionID)
    stopWatchTimer(sessionID)
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
    const message = existed ? "Loop stopped." : wasWatching ? "Stopped watching." : "No active loop to stop."
    await toast(client, message, "info")
    return
  }

  if (lower === "watch" || lower.startsWith("watch ")) {
    const parsed = parseWatchArgs(arg.slice("watch".length))
    if ("error" in parsed) return void (await toast(client, parsed.error, "warning"))
    const intervalMs = parsed.intervalMs ?? Math.max(config.watchIntervalMinutes * 60_000, MIN_WATCH_INTERVAL_MS)
    watching.add(sessionID)
    stopWatchTimer(sessionID) // replace any prior timer instead of stacking
    watchTimers.set(
      sessionID,
      setInterval(() => void watchTick(deps, sessionID, config), intervalMs),
    )
    watchIntervalsMs.set(sessionID, intervalMs)
    await toast(client, `Watching for approved tasks to build (polling every ${formatInterval(intervalMs)}).`, "info")
    return
  }

  if (lower === "unwatch") {
    const was = watching.delete(sessionID)
    stopWatchTimer(sessionID)
    await toast(client, was ? "Stopped watching." : "Not watching.", "info")
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
      return void (await toast(client, `Task "${id}" has no persisted plan — re-plan it with /loop-plan task ${id}, then approve it again.`, "warning"))
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

  if (lower === "ship" || lower.startsWith("ship ")) {
    const id = arg.slice("ship".length).trim()
    if (!id) return void (await toast(client, "Usage: /loop ship <id>.", "warning"))
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-review", id)
    if (!task) {
      // Locate it for a precise error instead of a bare "not found".
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail = elsewhere ? `it's in ${elsewhere}, not in-review — the loop hasn't finished it` : `no task "${id}" found`
      return void (await toast(client, `Can't ship "${id}": ${detail}.`, "warning"))
    }
    try {
      await appendNote(deps.$, task, auditNote("Shipped — moved to completed", new Date(), await gitActor(deps.$, deps.directory)))
      await moveTask(deps.$, task, "completed")
      await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): shipped — completed`)
      await toast(client, `"${task.title}" completed.`, "success")
    } catch (err) {
      await toast(client, `Ship failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  if (lower === "task" || lower.startsWith(TASK_PREFIX)) {
    const id = arg.slice("task".length).trim()
    if (!id) return void (await toast(client, "Usage: /loop task <id>.", "warning"))
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) {
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail =
        elsewhere === "in-planning" || elsewhere === "draft"
          ? `it's in ${elsewhere} — approve its plan first with /loop-plan approve ${id}`
          : elsewhere
            ? `it's in ${elsewhere}`
            : `no task "${id}" found`
      return void (await toast(client, `Can't start "${id}": ${detail}.`, "warning"))
    }
    if (findSessionDriving(id)) {
      return void (await toast(client, `Task "${id}" is already being driven by a live loop.`, "warning"))
    }
    if (!isClaimable(task)) {
      const detail = isRecoverable(task)
        ? `was already started — resume it with /loop recover ${id}`
        : `has no persisted plan — run /loop-plan task ${id}, then /loop-plan approve ${id}`
      return void (await toast(client, `Task "${id}" ${detail}.`, "warning"))
    }
    if (!(await claimTask(deps.$, task))) {
      return void (await toast(client, `Task "${id}" was just claimed by another watcher.`, "warning"))
    }
    clearLoop(sessionID)
    pending.set(sessionID, { kind: "start-task", task, goal: taskGoal(task) })
    await toast(client, `Loop started on "${task.title}" — building…`, "info")
    return
  }

  if (lower === "status" || lower === "") {
    const isWatching = watching.has(sessionID)
    const state = getLoop(sessionID)
    // Backlog roll-up accompanies the session-loop line — a whole-backlog view,
    // not just this session's loop. Detailed flag lists go to the log.
    const summary = await backlogSummary(deps, config).catch(() => null)
    if (summary) {
      if (summary.interrupted.length) {
        await deps.log("warn", `interrupted (run /loop recover <id>): ${summary.interrupted.join(", ")}`)
      }
      if (summary.awaitingReview.length) {
        await deps.log("info", `awaiting diff review (run /loop ship <id>): ${summary.awaitingReview.join(", ")}`)
      }
    }
    const backlogLine = summary ? ` · ${formatBacklog(summary)}` : ""
    const cadence = watchIntervalsMs.get(sessionID)
    const watchLabel = cadence ? `Watching (every ${formatInterval(cadence)})` : "Watching"
    if (!state) {
      const head = isWatching ? `${watchLabel} — no claimable task right now.` : "No active loop."
      await toast(client, `${head}${backlogLine}`, "info")
      return
    }
    const what = state.task ? `task ${state.task.id}` : state.goal
    const prefix = isWatching ? `${watchLabel}. ` : ""
    await toast(client, `${prefix}Loop: ${state.stage} · iteration ${state.iteration + 1} · ${what}${backlogLine}`, "info")
    return
  }

  // The loop is a pure executor — there is no free-text mode. Anything
  // unrecognized gets usage help instead of silently becoming a goal.
  await toast(
    client,
    `Unknown /loop mode "${arg}". Usage: /loop task <id> · watch [interval] · unwatch · recover <id> · ship <id> · stop · status. ` +
      "Author and approve plans with /loop-plan.",
    "warning",
  )
}
