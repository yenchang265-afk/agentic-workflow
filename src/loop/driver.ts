import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { slugify, type Task } from "../task/schema.ts"
import {
  appendNote,
  appendRunLog,
  auditNote,
  claimFirst,
  claimTask,
  extractPlan,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedPlanClaim,
  isRecoverable,
  listByStatus,
  listClaimIds,
  listInProgress,
  listQueued,
  moveTask,
  releaseClaim,
  selectOrder,
  STALE_CLAIM_MINUTES,
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
  startAtPlan,
} from "./state.ts"

/**
 * Impure orchestration for the agentic loop. Thin glue over the pure helpers in
 * `state.ts`.
 *
 * Stepping is **sequential**: `client.session.command` resolves with the
 * completed stage's assistant message, so the driver fires a stage, captures its
 * output, feeds it back into the pure `advanceOnIdle` decision, and repeats until
 * a non-`fire` action (gate / done / stop). `session.idle` is used only as the
 * trigger to begin a drive once the `/agent-loop` command's own turn settles; a pending
 * marker selects what to run and a driving lock prevents re-entrancy from the
 * idle events the driver's own commands generate.
 *
 * Task authoring happens **before** the loop, in the `/agent-loop-task` command:
 * `new <idea>` interviews the user into a planless draft, and the deterministic
 * `approve <id>` subcommand (in `handleTaskCommand`) parks it planless in
 * `queued/`. Planning happens **inside** the loop, right before execution, so
 * plans don't rot while a task sits parked: a claimed `queued/` task enters at
 * the PLAN stage (`startAtPlan`), which writes the `## Implementation Plan`
 * onto the task file and terminates with a `park` action — the driver moves
 * the task to `plan-review/` and the loop exits without blocking on a human.
 * `/agent-loop-task approve-plan <id>` is the human plan gate: it moves the task to
 * `in-progress/` — the build-ready queue — and the next claim enters at
 * `build` via `resumeAtBuild` with the approved plan threaded in as an artifact.
 *
 * PLAN, or BUILD → VERIFY → REVIEW, runs either on demand (`/agent-loop task <id>`
 * claims one task) or via **watch mode** (the `watching` set + `tryClaim`): a
 * watching session scans `in-progress/` for one claimable task (`isClaimable`:
 * has a persisted plan, never started) — build work first — and falls back to
 * `queued/` for a task to plan. Watch is triggered two ways — every
 * `session.idle` event, plus a per-session interval timer (`/agent-loop watch
 * [interval]`) whose ticks call `onIdle` only when the session is actually
 * idle (queried via `client.session.status()`), so a task approved while the
 * session sat quiet still gets picked up. A VERIFY or REVIEW FAIL loops back
 * to `build` **inside this same session**, with the failure threaded into the
 * build prompt. Two watch sessions racing the same tick could both see a task
 * as claimable before either claims it; the atomic `claimTask` marker
 * resolves the race (in `queued/` and `in-progress/` alike).
 *
 * Task lifecycle: `/agent-loop-task new` authors into `draft/`; `approve <id>`
 * moves it to `queued/`; the loop's PLAN stage parks it in `plan-review/`;
 * `approve-plan <id>` moves it to `in-progress/`; a stop/failure while
 * building appends a note and leaves it in `in-progress/`; the loop finishing
 * (review PASS) moves it to `in-review/`, the human diff gate — a human runs
 * `/agent-loop ship <id>` to move it to `completed/`. If the plan itself turns out
 * wrong (rejected at the gate, or the iteration cap stops the loop), a human
 * sends it back to `queued/` with `/agent-loop-task replan <id>` and the PLAN
 * stage runs again with the failure context threaded in.
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
  | { readonly kind: "start-plan"; readonly task: Task; readonly goal: string }
  | { readonly kind: "recover"; readonly task: Task }
  | { readonly kind: "recover-state"; readonly state: LoopState }

const pending = new Map<string, Pending>()
const driving = new Set<string>()
/** Sessions in `/agent-loop watch` mode — a standing flag, not a one-shot `Pending`,
 *  since it must survive many no-op idle ticks between claims. */
const watching = new Set<string>()
/** Per-watching-session polling timers and their cadence (for status display). */
const watchTimers = new Map<string, ReturnType<typeof setInterval>>()
const watchIntervalsMs = new Map<string, number>()
/**
 * Last no-claim reason toasted per watch session. Every tick logs its reason,
 * but the toast fires only when the reason CHANGES — a held marker or an
 * unplanned backlog would otherwise re-toast every 10s tick. Cleared on
 * successful claim, stop, unwatch, and (re-)watch so a re-arm re-toasts.
 */
const lastSkipReason = new Map<string, string>()
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
      throw new Error(`could not create worktree ${wtPath} for ${branch} — resolve it, then /agent-loop recover`)
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
 * The slash command a stage fires. `build`/`verify`/`review` match their
 * command names; `plan` maps to `plan-task` — the loop's plan-writing stage
 * command (`loop-plan-author` in task mode) — because the bare `/plan`
 * command is the ad-hoc, nothing-persisted planner. Pure.
 */
const stageCommand = (stage: Stage): string => (stage === "plan" ? "plan-task" : stage)

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
 * `/agent-loop stop` clears the loop mid-pass.
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
    const out = await runStage(client, sessionID, stageCommand(stage), args, config.stageTimeoutMinutes)
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
    if (!getLoop(sessionID)) break // /agent-loop stop mid-pass — don't fire the rest
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
    // Every code-writing stage runs isolated: its own worktree (worktree mode)
    // or the loop/<id> branch in the shared tree (default). Created on the
    // first build; reconciled before every stage in case the tree/worktree
    // moved — including a snapshot-based `/agent-loop recover` that re-enters
    // directly at verify/review, where isolation must be re-established, not
    // assumed. PLAN is the exception: it writes only the task file (in the
    // main tree, on the human's branch) and parks, so it needs no branch, no
    // worktree, and no crash snapshot — a died PLAN is recovered by the stale
    // claim-marker sweep, not by /agent-loop recover.
    if (stage !== "plan") {
      step = { ...step, state: await ensureIsolation(deps, config, step.state) }
    }
    setLoop(sessionID, step.state)
    if (stage !== "plan") await snapshot(deps, config, step.state)
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
    // A /agent-loop stop while the stage ran cleared this session's loop — halt the
    // chain, preserving whatever the stage did as a checkpoint on the branch.
    if (!getLoop(sessionID)) {
      await renderMetrics(deps, sessionID, config, step.state, "stopped", `stopped during ${stage}`)
      await checkpoint(deps, step.state, `loop(${loopId(step.state)}): incomplete — stopped during ${stage}`)
      await teardownIsolation(deps, step.state)
      // A deliberate /agent-loop stop ends the run — drop the snapshot so a later
      // /agent-loop recover doesn't silently resurrect it from stale state.
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
    case "park": {
      // PLAN finished. Validate the plan actually landed on disk before
      // parking — a stage that wrote nothing must not put a planless task in
      // front of the human gate.
      if (!state.task) {
        clearLoop(sessionID)
        return
      }
      const fresh = await findByIdIn(client, deps.directory, config.tasksDir, "queued", state.task.id)
      if (!fresh || !hasPlan(fresh)) {
        const why = fresh ? "the PLAN stage wrote no ## Implementation Plan" : "the task left queued/ mid-plan"
        await deps.log("warn", `loop(${state.task.id}): not parking — ${why}`)
        if (fresh) {
          await appendNote(deps.$, fresh, auditNote(`PLAN stage failed — ${why}; still queued`, new Date(), actor), deps.log)
          await releaseClaim(deps.$, fresh)
        }
        await renderMetrics(deps, sessionID, config, state, "error", why)
        clearLoop(sessionID)
        await toast(client, `PLAN failed for "${state.task.id}" — ${why}. It stays in queued/.`, "error")
        return
      }
      await appendNote(deps.$, fresh, auditNote("Plan written — parked for plan review", new Date(), actor), deps.log)
      await moveTask(deps.$, fresh, "plan-review") // also releases the queued/ claim marker
      await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${state.task.id}): plan written — parked for review`)
      await renderMetrics(deps, sessionID, config, state, "done", "plan parked for review")
      clearLoop(sessionID)
      await toast(
        client,
        `${action.message} Review it, then /agent-loop-task approve-plan ${state.task.id} (or replan ${state.task.id}).`,
        "success",
      )
      return
    }
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
        ? ` Review the diff${where}, then run /agent-loop ship ${state.task.id} when it ships.`
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

/** Why a watch tick claimed nothing — the message, and whether a human can act on it. */
export interface ClaimSkipReason {
  readonly message: string
  readonly actionable: boolean
}

/**
 * Compute why a watch tick claimed nothing, from what the claim walk saw
 * across both pools (`in-progress/` build work, then `queued/` plan work).
 * Held markers win (they block otherwise-ready work); then empty backlog;
 * then started-but-unclaimed (recover); then the no-plan fallback. Pure.
 */
export const claimSkipReason = (
  inProgressCount: number,
  claimableCount: number,
  queuedCount: number,
  startedIds: readonly string[],
  heldIds: readonly string[],
): ClaimSkipReason => {
  if (heldIds.length) {
    return {
      message:
        `watch: claim marker held for ${heldIds.join(", ")} — another watcher may be working it; ` +
        `a stale marker auto-releases after ${STALE_CLAIM_MINUTES}m`,
      actionable: true,
    }
  }
  if (inProgressCount === 0 && queuedCount === 0) {
    return { message: "watch: nothing to claim — queued/ and in-progress/ are both empty", actionable: false }
  }
  if (claimableCount === 0 && startedIds.length) {
    return {
      message:
        `watch: 0 claimable — ${startedIds.length} in-progress task(s) already started: ` +
        `${startedIds.join(", ")} (run /agent-loop recover <id>)`,
      actionable: true,
    }
  }
  return {
    message:
      "watch: 0 claimable — in-progress task(s) have no persisted plan (send them back with /agent-loop-task replan <id>)",
    actionable: true,
  }
}

/**
 * A `/agent-loop watch` session's own idle check, over two pools in order:
 * first a claimable task in `in-progress/` (plan approved, never started) is
 * driven straight through BUILD → VERIFY → REVIEW — build work beats plan
 * work, so in-flight tasks finish before new ones spin up. Otherwise a
 * `queued/` task (approved, planless) is claimed for the PLAN stage, which
 * writes its plan and parks it in `plan-review/` for the human gate.
 * FAIL-driven re-builds happen inline in this same session, exactly like a
 * normal loop's iteration cap. Never silent: when nothing is claimed, the
 * reason is always logged, and toasted when actionable (deduped until the
 * reason changes).
 */
const tryClaim = async (deps: Deps, sessionID: string, config: Config): Promise<void> => {
  const tasks = await listInProgress(deps.client, deps.directory, config.tasksDir, deps.log)
  const candidates = selectOrder(tasks.filter(isClaimable))
  // Atomic claim markers: only one watcher on this filesystem wins a task, even
  // when several saw it as claimable on the same idle tick. A held marker skips
  // to the next candidate instead of wedging the queue; an orphaned marker
  // (stale, claimer died before BUILD started) is released and retried inline.
  const { claimed, heldIds } = await claimFirst(deps.$, candidates, {
    isDriving: (id) => findSessionDriving(id) !== undefined,
    log: deps.log,
  })
  if (claimed) {
    lastSkipReason.delete(sessionID)
    const ref = taskRef(claimed, claimed.path)
    const state = resumeAtBuild(taskGoal(claimed), ref, extractPlan(claimed) ?? "")
    await toast(deps.client, `Watch: claimed "${claimed.title}" — building…`, "info")
    try {
      await drive(deps, sessionID, config, firstStep(state))
    } catch (err) {
      // Died before the first "> BUILD started" note (e.g. ensureIsolation threw,
      // before setLoop ran — onIdle's catch can't see the task): the claim is ours
      // and the body is still claimable, so release it or watch stays wedged.
      const fresh = await findByIdIn(deps.client, deps.directory, config.tasksDir, "in-progress", claimed.id)
      if (fresh && isClaimable(fresh)) await releaseClaim(deps.$, claimed)
      throw err
    }
    return
  }

  // No build work — look for a queued task to plan. The planless-orphan
  // predicate applies: PLAN writes no code, so a stale undriven marker is
  // always safe to release.
  const queued = await listQueued(deps.client, deps.directory, config.tasksDir, deps.log)
  const planWalk = await claimFirst(deps.$, selectOrder(queued), {
    isDriving: (id) => findSessionDriving(id) !== undefined,
    isOrphaned: isOrphanedPlanClaim,
    log: deps.log,
  })
  if (!planWalk.claimed) {
    const started = tasks.filter(isRecoverable).map((t) => t.id)
    const reason = claimSkipReason(tasks.length, candidates.length, queued.length, started, [
      ...heldIds,
      ...planWalk.heldIds,
    ])
    await deps.log(reason.actionable ? "warn" : "info", reason.message)
    if (reason.actionable && lastSkipReason.get(sessionID) !== reason.message) {
      lastSkipReason.set(sessionID, reason.message)
      await toast(deps.client, reason.message, "warning")
    }
    return
  }
  lastSkipReason.delete(sessionID)
  const task = planWalk.claimed
  const state = startAtPlan(taskGoal(task), taskRef(task, task.path), extractPlan(task))
  await toast(deps.client, `Watch: claimed "${task.title}" — planning…`, "info")
  try {
    await drive(deps, sessionID, config, firstStep(state))
  } catch (err) {
    // A PLAN that died leaves the task in queued/ with our marker — release it.
    const fresh = await findByIdIn(deps.client, deps.directory, config.tasksDir, "queued", task.id)
    if (fresh) await releaseClaim(deps.$, task)
    throw err
  }
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
  const claimedIds = await listClaimIds(deps.$, deps.directory, config.tasksDir)
  return summarizeBacklog(byStatus, claimedIds)
}

/** Human-readable one-liner of the backlog roll-up. Pure. */
const formatBacklog = (s: Awaited<ReturnType<typeof backlogSummary>>): string => {
  const c = s.counts
  const gate = c["plan-review"] > 0 ? `${c["plan-review"]} plan-review (awaiting approve-plan)` : "0 plan-review"
  const held = s.claimHeld.length ? `, ${s.claimHeld.length} claim-held` : ""
  const progress =
    c["in-progress"] > 0
      ? `${c["in-progress"]} in-progress (${s.claimable.length} ready${held}, ${s.interrupted.length} interrupted)`
      : "0 in-progress"
  return `backlog: ${c.draft} draft · ${c.queued} queued · ${gate} · ${progress} · ${c["in-review"]} in-review · ${c.completed} completed · ${c.abandoned} abandoned`
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
      // `start-task`: a `/agent-loop task <id>` claim entering execution at build.
      // `recover`: a human-forced resume of a started-but-dead task with no
      // valid snapshot. Both re-enter the state machine at build with the
      // persisted plan.
      const ref = taskRef(work.task, work.task.path)
      const state = resumeAtBuild(taskGoal(work.task), ref, extractPlan(work.task) ?? "")
      await drive(deps, sessionID, config, firstStep(state))
    } else if (work?.kind === "start-plan") {
      // A `/agent-loop task <id>` claim on a queued (planless) task: run the PLAN
      // stage, which writes the plan and parks the task in plan-review/.
      const state = startAtPlan(work.goal, taskRef(work.task, work.task.path), extractPlan(work.task))
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
    // A claim that died before its first "> BUILD started" note leaves the
    // task body claimable but the marker held — release it so no watcher is
    // wedged on it forever. (For `recover`, the body already carries BUILD
    // notes, so `isClaimable` is false and this is a no-op.)
    if (work?.kind === "start-task" || work?.kind === "recover") {
      const fresh = await findByIdIn(deps.client, deps.directory, config.tasksDir, "in-progress", work.task.id)
      if (fresh && isClaimable(fresh)) await releaseClaim(deps.$, work.task)
    }
    // A PLAN claim that died leaves the task in queued/ with the marker held.
    if (work?.kind === "start-plan") {
      const fresh = await findByIdIn(deps.client, deps.directory, config.tasksDir, "queued", work.task.id)
      if (fresh) await releaseClaim(deps.$, work.task)
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

// --- /agent-loop command handling (parses the mode; deferred work runs on next idle) ---

const TASK_PREFIX = "task "

/** Human-readable rendering of a polling cadence in ms. Pure. */
const formatInterval = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`

/** Minimum watch polling cadence — anything tighter just burns idle queries. */
const MIN_WATCH_INTERVAL_MS = 10_000

/**
 * Parse the interval spec of `/agent-loop watch [interval]`. Accepts `""` (use the
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
 * the case that path misses — a task approved (by `/agent-loop-task` in
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

/** Parsed `/agent-loop-task` arguments: which subcommand needs plugin work, if any. */
export type TaskCmdArgs = { mode: "approve" | "approve-plan" | "replan"; id: string; reason?: string } | { mode: "passthrough" }

/**
 * Classify `/agent-loop-task` arguments. `approve <id>`, `approve-plan <id>`,
 * and `replan <id> [reason]` are fully deterministic plugin work; everything
 * else (including `new <idea>`) passes through untouched. `approve-plan` is
 * matched before `approve` (prefix collision). An empty id is preserved so
 * the caller can toast a usage hint.
 */
export const parseTaskArgs = (args: string): TaskCmdArgs => {
  const arg = args.trim()
  const lower = arg.toLowerCase()
  for (const mode of ["approve-plan", "approve", "replan"] as const) {
    if (lower === mode || lower.startsWith(`${mode} `)) {
      const rest = arg.slice(mode.length).trim()
      if (mode === "replan") {
        const [id = "", ...reasonParts] = rest.split(/\s+/)
        const reason = reasonParts.join(" ")
        return { mode, id, ...(reason ? { reason } : {}) }
      }
      return { mode, id: rest }
    }
  }
  return { mode: "passthrough" }
}

/**
 * Handle a `/agent-loop-task ...` command. Three subcommands are deterministic
 * plugin work (the agent writes nothing); `new <idea>` passes through
 * untouched — its authoring (interview, draft) is the agent's job, see
 * `.opencode/commands/agent-loop-task.md`:
 *
 * - `approve <id>` — the task gate: park a reviewed `draft/` task in
 *   `queued/`. No plan is required (or expected) — planning happens inside
 *   the loop's PLAN stage, right before execution.
 * - `approve-plan <id>` — the plan gate: validate the `plan-review/` task has
 *   an `## Implementation Plan` and park it in `in-progress/`, the
 *   build-ready queue.
 * - `replan <id> [reason]` — reject a parked plan, or send a cap-tripped
 *   `in-progress/` task back: moves it to `queued/` with an audited note so
 *   the next PLAN pass addresses why the old plan failed.
 */
export const handleTaskCommand = async (deps: Deps, _sessionID: string, args: string, config: Config): Promise<void> => {
  const { client } = deps
  const parsed = parseTaskArgs(args)
  if (parsed.mode === "passthrough") return
  const { id } = parsed
  if (!id) return void (await toast(client, `Usage: /agent-loop-task ${parsed.mode} <id>.`, "warning"))

  if (parsed.mode === "approve") {
    const draft = await findByIdIn(client, deps.directory, config.tasksDir, "draft", id)
    if (!draft) {
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail = elsewhere ? `it's in ${elsewhere} — only draft tasks can be approved` : `no task "${id}" found`
      return void (await toast(client, `Can't approve "${id}": ${detail}.`, "warning"))
    }
    try {
      const actor = await gitActor(deps.$, deps.directory)
      await appendNote(deps.$, draft, auditNote("Task approved — queued for planning", new Date(), actor))
      await moveTask(deps.$, draft, "queued")
      await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): task approved — queued for planning`)
      await toast(
        client,
        `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/. /agent-loop watch (or /agent-loop task ${id}) will plan it.`,
        "success",
      )
    } catch (err) {
      await toast(client, `Approve failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  if (parsed.mode === "approve-plan") {
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "plan-review", id)
    if (!task) {
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail =
        elsewhere === "queued"
          ? `it's still queued — the loop hasn't planned it yet (/agent-loop task ${id} plans it now)`
          : elsewhere === "draft"
            ? `it's still a draft — approve the task first with /agent-loop-task approve ${id}`
            : elsewhere
              ? `it's in ${elsewhere} — only plan-review tasks can be plan-approved`
              : `no task "${id}" found`
      return void (await toast(client, `Can't approve the plan for "${id}": ${detail}.`, "warning"))
    }
    if (!hasPlan(task)) {
      return void (
        await toast(client, `Task "${id}" has no Implementation Plan — send it back with /agent-loop-task replan ${id}.`, "warning")
      )
    }
    try {
      const actor = await gitActor(deps.$, deps.directory)
      await appendNote(deps.$, task, auditNote("Plan approved — parked for execution", new Date(), actor))
      await moveTask(deps.$, task, "in-progress")
      await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): plan approved — parked for execution`)
      await toast(
        client,
        `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/. /agent-loop watch (or /agent-loop task ${id}) will build it.`,
        "success",
      )
    } catch (err) {
      await toast(client, `Approve-plan failed for "${id}": ${(err as Error).message}`, "error")
    }
    return
  }

  // replan — from plan-review/ (rejected plan) or in-progress/ (cap-tripped / bad plan).
  const task =
    (await findByIdIn(client, deps.directory, config.tasksDir, "plan-review", id)) ??
    (await findByIdIn(client, deps.directory, config.tasksDir, "in-progress", id))
  if (!task) {
    const elsewhere = await findAnyStatus(deps, config, id)
    const detail = elsewhere
      ? `it's in ${elsewhere} — only plan-review or in-progress tasks can be sent back to planning`
      : `no task "${id}" found`
    return void (await toast(client, `Can't replan "${id}": ${detail}.`, "warning"))
  }
  if (findSessionDriving(id)) {
    return void (await toast(client, `Task "${id}" is being driven by a live loop — /agent-loop stop it first.`, "warning"))
  }
  try {
    const actor = await gitActor(deps.$, deps.directory)
    const why = parsed.reason ? ` — ${parsed.reason}` : ""
    await appendNote(deps.$, task, auditNote(`Plan rejected — sent back to queued for re-planning${why}`, new Date(), actor))
    await moveTask(deps.$, task, "queued")
    await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): plan rejected — re-queued for planning`)
    await toast(
      client,
      `"${task.title}" sent back to ${config.tasksDir}/queued/ — the next PLAN pass will address the rejection.`,
      "success",
    )
  } catch (err) {
    await toast(client, `Replan failed for "${id}": ${(err as Error).message}`, "error")
  }
}

/** Parse and handle a `/agent-loop ...` command. */
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
      "The gates live in /agent-loop-task: approve <id> queues a draft for planning, approve-plan <id> releases a parked plan for execution.",
      "warning",
    )
    return
  }

  if (lower === "next") {
    await toast(
      client,
      "/agent-loop next was removed — author and approve a task with /agent-loop-task, then /agent-loop task <id> or /agent-loop watch.",
      "warning",
    )
    return
  }

  if (lower === "stop" || lower === "abort") {
    const wasWatching = watching.delete(sessionID)
    stopWatchTimer(sessionID)
    lastSkipReason.delete(sessionID)
    pending.delete(sessionID)
    const state = getLoop(sessionID)
    if (state?.task) {
      await appendNote(
        deps.$,
        state.task,
        auditNote(
          `Loop stopped by /agent-loop stop — was at ${state.stage} (iteration ${state.iteration + 1}).`,
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
    lastSkipReason.delete(sessionID) // a fresh arm re-toasts whatever reason comes next
    await toast(client, `Watching for approved tasks to build (polling every ${formatInterval(intervalMs)}).`, "info")
    // Immediate first pull — don't make the user wait for the next idle event
    // or timer tick. watchTick self-guards: it claims only when the session is
    // actually idle, and never throws.
    void watchTick(deps, sessionID, config)
    return
  }

  if (lower === "unwatch") {
    const was = watching.delete(sessionID)
    stopWatchTimer(sessionID)
    lastSkipReason.delete(sessionID)
    await toast(client, was ? "Stopped watching." : "Not watching.", "info")
    return
  }

  if (lower === "recover" || lower.startsWith("recover ")) {
    const id = arg.slice("recover".length).trim()
    if (!id) return void (await toast(client, "Usage: /agent-loop recover <id>.", "warning"))
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) return void (await toast(client, `No in-progress task "${id}".`, "warning"))
    const driving = findSessionDriving(id)
    if (driving) {
      return void (await toast(client, `Task "${id}" is being driven by a live loop — nothing to recover.`, "warning"))
    }
    if (isClaimable(task)) {
      return void (await toast(client, `Task "${id}" was never started — /agent-loop watch will claim it.`, "info"))
    }
    if (!isRecoverable(task)) {
      return void (await toast(client, `Task "${id}" has no persisted plan — send it back with /agent-loop-task replan ${id}.`, "warning"))
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
        auditNote(`Recovered by /agent-loop recover — resuming from snapshot at ${snap.stage}.`, new Date(), actor),
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
      auditNote("Recovered by /agent-loop recover — resuming BUILD from the persisted plan.", new Date(), actor),
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
    if (!id) return void (await toast(client, "Usage: /agent-loop ship <id>.", "warning"))
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
    if (!id) return void (await toast(client, "Usage: /agent-loop task <id>.", "warning"))
    const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-progress", id)
    if (!task) {
      // Not build-ready — a queued task enters at the PLAN stage instead.
      const queued = await findByIdIn(client, deps.directory, config.tasksDir, "queued", id)
      if (queued) {
        if (findSessionDriving(id)) {
          return void (await toast(client, `Task "${id}" is already being driven by a live loop.`, "warning"))
        }
        if (!(await claimTask(deps.$, queued))) {
          return void (await toast(client, `Task "${id}" was just claimed by another watcher.`, "warning"))
        }
        clearLoop(sessionID)
        pending.set(sessionID, { kind: "start-plan", task: queued, goal: taskGoal(queued) })
        await toast(client, `Loop started on "${queued.title}" — planning… (it will park in plan-review/ for your gate)`, "info")
        return
      }
      const elsewhere = await findAnyStatus(deps, config, id)
      const detail =
        elsewhere === "plan-review"
          ? `its plan is parked for review — /agent-loop-task approve-plan ${id} (or replan ${id})`
          : elsewhere === "draft"
            ? `it's a draft — approve it first with /agent-loop-task approve ${id}`
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
        ? `was already started — resume it with /agent-loop recover ${id}`
        : `has no persisted plan — send it back to planning with /agent-loop-task replan ${id}`
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
        await deps.log("warn", `interrupted (run /agent-loop recover <id>): ${summary.interrupted.join(", ")}`)
      }
      if (summary.awaitingReview.length) {
        await deps.log("info", `awaiting diff review (run /agent-loop ship <id>): ${summary.awaitingReview.join(", ")}`)
      }
    }
    const backlogLine = summary ? ` · ${formatBacklog(summary)}` : ""
    const cadence = watchIntervalsMs.get(sessionID)
    const watchLabel = cadence ? `Watching (every ${formatInterval(cadence)})` : "Watching"
    if (!state) {
      // Prefer the remembered skip reason over a bare "no claimable task" —
      // it says WHY the watcher isn't picking anything up.
      const why = lastSkipReason.get(sessionID)
      const head = isWatching ? `${watchLabel} — ${why ?? "no claimable task right now."}` : "No active loop."
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
    `Unknown /agent-loop mode "${arg}". Usage: /agent-loop task <id> · watch [interval] · unwatch · recover <id> · ship <id> · stop · status. ` +
      "Author and approve tasks (and plans) with /agent-loop-task.",
    "warning",
  )
}
