import type { Verdict } from "./verdict.ts"

/**
 * Loop state machine for the agentic loop:
 *
 *   build → verify → review
 *
 * The transition helpers here are **pure**: given a state (and config) they
 * return a new state plus an `Action` describing what the driver should do, and
 * never touch a client or the store. That keeps the loop logic unit-testable
 * without opencode. The impure orchestration lives in `driver.ts`.
 *
 * Planning happens **before** the loop, in the `/agent-loop-plan` command: `new`
 * interviews the user into a draft task, `task <id>` writes its
 * `## Implementation Plan`, and `/agent-loop-plan approve <id>` parks it in
 * `in-progress/`. The loop is a pure executor — every state enters at
 * `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * re-plans via `/agent-loop-plan task <id>`.
 */

export type Stage = "build" | "verify" | "review"

/** The stages in loop order. */
export const STAGES: readonly Stage[] = ["build", "verify", "review"]

/** Link to the backlog task driving the loop, when started from one. */
export interface TaskRef {
  readonly id: string
  /** Current on-disk path of the task file (updated as it moves between folders). */
  readonly path: string
  /** Acceptance criteria threaded into the build/verify prompts. */
  readonly acceptance: readonly string[]
}

/** The git isolation for one loop's execution: work happens on `branch`, cut from `base`. */
export interface GitRef {
  readonly base: string
  readonly branch: string
  /**
   * Absolute path to this loop's dedicated worktree, when worktree isolation is
   * enabled (`worktreesDir` config). Absent ⇒ shared-tree mode: `branch` is
   * checked out in the main tree. Present ⇒ stages run pinned to this directory.
   */
  readonly worktree?: string
}

export interface LoopState {
  /** The goal the loop is driving toward. */
  readonly goal: string
  /** The stage currently running or most recently completed. */
  readonly stage: Stage
  /** 0-based loop iteration; incremented on a verify-FAIL or review-FAIL re-build. */
  readonly iteration: number
  /** Captured output text per completed stage, used to thread context forward.
   *  Also carries the approved plan under the `plan` key. */
  readonly artifacts: Readonly<Partial<Record<Stage | "plan", string>>>
  /** Set when the loop was started from a backlog task; absent only for defensive fallbacks. */
  readonly task?: TaskRef
  /** Set by the driver once execution is isolated on its own git branch. */
  readonly git?: GitRef
}

/** What the driver should do next. All state changes are returned, not applied. */
export type Action =
  | { readonly kind: "fire"; readonly stage: Stage; readonly arguments: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "stop"; readonly message: string }
  | { readonly kind: "noop" }

export interface Config {
  readonly maxIterations: number
  /** Repo-relative root of the task backlog (folders are statuses). */
  readonly tasksDir: string
  /** Wall-clock cap on a single stage before the loop gives up on it. */
  readonly stageTimeoutMinutes: number
  /** Default polling cadence for `/agent-loop watch` (overridable per-session: `/agent-loop watch 30s`). */
  readonly watchIntervalMinutes: number
  /** Per-task worktree root; unset ⇒ shared-tree branch switching. */
  readonly worktreesDir?: string
  /** Shell command run in a fresh worktree after creation. */
  readonly worktreeSetup?: string
  /** Extra REVIEW lenses; each runs one more focused review pass. */
  readonly reviewLenses: readonly string[]
}

/** Construct a LoopState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agent-loop-plan approve`. */
export const resumeAtBuild = (goal: string, task: TaskRef, plan: string): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: { plan },
  task,
})

const withArtifact = (state: LoopState, stage: Stage, output: string): LoopState => ({
  ...state,
  artifacts: { ...state.artifacts, [stage]: output },
})

/** Drop a stale check artifact so a re-build doesn't thread outdated feedback. */
const withoutArtifact = (state: LoopState, stage: Stage): LoopState => {
  const { [stage]: _dropped, ...rest } = state.artifacts
  return { ...state, artifacts: rest }
}

/** Compose the prompt threaded into a stage command: goal + relevant prior artifacts. */
export const composeArgs = (state: LoopState, target: Stage): string => {
  const a = state.artifacts
  const accept = state.task?.acceptance ?? []
  const acceptBlock = (heading: string): string => `${heading}\n${accept.map((c) => `- ${c}`).join("\n")}`
  const parts: string[] = [`Goal: ${state.goal}`]
  if (target === "build") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.verify) parts.push(`Verify failure to address:\n${a.verify}`)
    if (a.review) parts.push(`Review feedback to address:\n${a.review}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the build must satisfy each):"))
  } else if (target === "verify") {
    if (a.plan) parts.push(`Plan & acceptance criteria:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the verdict must check each):"))
  } else if (target === "review") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
    if (state.git) {
      const wt = state.git.worktree
      const diffCmd = wt
        ? `git -C ${wt} diff ${state.git.base}...${state.git.branch}`
        : `git diff ${state.git.base}...${state.git.branch}`
      parts.push(
        `Diff boundary: this loop's work is the commits on branch ${state.git.branch} since ${state.git.base} — ` +
          `review exactly \`${diffCmd}\`, nothing outside it.`,
      )
    }
  }
  // Worktree pinning: BUILD/VERIFY/REVIEW run in the one plugin instance, so the
  // isolated checkout is threaded in as an instruction rather than a real cwd.
  if (state.git?.worktree) {
    parts.push(
      `Worktree: this loop's isolated checkout is ${state.git.worktree} — every file you read, edit, or ` +
        `test lives THERE, not in the repo root. Use absolute paths under it for edit/read; prefix every ` +
        `shell command with \`cd ${state.git.worktree} && \` (or use \`git -C ${state.git.worktree} …\`). ` +
        `Never modify anything outside it.`,
    )
  }
  return parts.join("\n\n")
}

const fire = (state: LoopState, stage: Stage): { state: LoopState; action: Action } => ({
  state: { ...state, stage },
  action: { kind: "fire", stage, arguments: composeArgs({ ...state, stage }, stage) },
})

/**
 * Decide what to do when the session goes idle after `state.stage` completed.
 * `output` is that stage's captured assistant text (stored as its artifact).
 * `verdict` is the check stage's resolved verdict — recorded via the
 * `loop_verdict` tool and resolved by the driver, never parsed out of
 * `output` here (free text is an untrusted channel; see verdict.ts). A
 * missing verdict is a FAIL, not a stall.
 */
export const advanceOnIdle = (
  state: LoopState,
  config: Config,
  output: string,
  verdict: Verdict | null = null,
): { state: LoopState; action: Action } => {
  const s = withArtifact(state, state.stage, output)

  switch (s.stage) {
    case "build":
      return fire(s, "verify")

    case "verify": {
      if (verdict === "PASS") {
        return fire(s, "review")
      }
      if (verdict === "ERROR") {
        // The check itself couldn't run — a broken environment, not a bad
        // build. Re-building would burn iterations on something no build fixes.
        return {
          state: s,
          action: {
            kind: "stop",
            message: "✗ Loop stopped — verify could not run (environment/infrastructure error). Fix the environment, then /agent-loop recover the task.",
          },
        }
      }
      // FAIL (or no recorded verdict): re-build if budget remains, else stop.
      if (s.iteration + 1 < config.maxIterations) {
        // Drop any stale review feedback — it judged an older build.
        const next = { ...withoutArtifact(s, "review"), iteration: s.iteration + 1 }
        return fire(next, "build")
      }
      return {
        state: s,
        action: {
          kind: "stop",
          message: `✗ Loop stopped — verify failed after ${config.maxIterations} iterations. If the plan itself is wrong, re-plan with /agent-loop-plan task <id>.`,
        },
      }
    }

    case "review": {
      if (verdict === "PASS") {
        return {
          state: s,
          action: { kind: "done", message: "✓ Loop done — review passed. Ship it yourself." },
        }
      }
      if (verdict === "ERROR") {
        return {
          state: s,
          action: {
            kind: "stop",
            message: "✗ Loop stopped — review could not run (environment/infrastructure error). Fix the environment, then /agent-loop recover the task.",
          },
        }
      }
      // FAIL (or no recorded verdict): re-build if budget remains, else stop.
      if (s.iteration + 1 < config.maxIterations) {
        // Drop the stale verify output — it passed on an older build.
        const next = { ...withoutArtifact(s, "verify"), iteration: s.iteration + 1 }
        return fire(next, "build")
      }
      return {
        state: s,
        action: {
          kind: "stop",
          message: `✗ Loop stopped — review failed after ${config.maxIterations} iterations. If the plan itself is wrong, re-plan with /agent-loop-plan task <id>.`,
        },
      }
    }
  }
}

/** The first step to drive for a freshly-constructed state — fires its own stage. */
export const firstStep = (state: LoopState): { state: LoopState; action: Action } => ({
  state,
  action: { kind: "fire", stage: state.stage, arguments: composeArgs(state, state.stage) },
})

// --- In-memory store (lost on opencode restart; see README known limitations) ---

const store = new Map<string, LoopState>()

export const getLoop = (sessionID: string): LoopState | undefined => store.get(sessionID)
/** The session whose live loop is driving the given task id, if any (this plugin instance only). */
export const findSessionDriving = (taskId: string): string | undefined => {
  for (const [sessionID, state] of store) if (state.task?.id === taskId) return sessionID
  return undefined
}
export const setLoop = (sessionID: string, state: LoopState): void => void store.set(sessionID, state)
export const clearLoop = (sessionID: string): boolean => store.delete(sessionID)
export const hasLoop = (sessionID: string): boolean => store.has(sessionID)
