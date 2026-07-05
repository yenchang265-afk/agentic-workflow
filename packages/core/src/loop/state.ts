/**
 * Loop state machine for the agentic loop:
 *
 *   plan → (park for plan review) · build → verify → review
 *
 * The types and state constructors here are **pure**. The transition logic
 * lives in `engine.ts`, interpreting a loop kind's manifest (the engineering
 * pipeline above is `loops/engineering/loop.json`); the impure orchestration
 * lives in each host's driver.
 *
 * Task authoring happens **before** the loop, in the `/agent-loop-task`
 * command: `new` interviews the user into a draft task and `approve <id>`
 * parks it planless in `queued/`. The loop claims a queued task and enters at
 * `plan` via `startAtPlan` — the PLAN stage writes the task's
 * `## Implementation Plan` right before execution, so plans don't rot while a
 * task sits parked. PLAN never blocks on a human: it terminates with a `park`
 * action (the driver moves the task to `plan-review/` and the loop exits).
 * `/agent-loop-task approve-plan <id>` is the human plan gate; the next claim
 * enters at `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * sends the task back to the PLAN stage via `/agent-loop-task replan <id>`.
 */

/** A stage name. Loop kinds define their own stage sets in their manifests;
 *  the engineering loop's are `plan | build | verify | review`. */
export type Stage = string

/** The engineering loop's stages in order. `plan` terminates with a park, not an advance. */
export const STAGES: readonly Stage[] = ["plan", "build", "verify", "review"]

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
  /** The loop kind driving this state (a manifest's `kind`); absent ⇒ `engineering`. */
  readonly kind?: string
  /** The goal the loop is driving toward. */
  readonly goal: string
  /** The stage currently running or most recently completed. */
  readonly stage: Stage
  /** 0-based loop iteration; incremented on a counted re-fire (e.g. a verify-FAIL re-build). */
  readonly iteration: number
  /** Captured output text per completed stage, used to thread context forward.
   *  Also carries the approved plan under the `plan` key. */
  readonly artifacts: Readonly<Record<string, string>>
  /** Set when the loop was started from a backlog task; absent only for defensive fallbacks. */
  readonly task?: TaskRef
  /** Set by the driver once execution is isolated on its own git branch. */
  readonly git?: GitRef
}

/** What the driver should do next. All state changes are returned, not applied. */
export type Action =
  | { readonly kind: "fire"; readonly stage: Stage; readonly arguments: string }
  | { readonly kind: "done"; readonly message: string; readonly toStatus?: string }
  /** A gate stage finished: the driver validates its output, moves the item to `toStatus`, and the loop exits. */
  | { readonly kind: "park"; readonly message: string; readonly toStatus?: string }
  | { readonly kind: "stop"; readonly message: string }
  | { readonly kind: "noop" }

export interface Config {
  readonly maxIterations: number
  /** Repo-relative root of the task backlog (folders are statuses). */
  readonly tasksDir: string
  /** Wall-clock cap on a single stage before the loop gives up on it. */
  readonly stageTimeoutMinutes: number
  /** Per-task worktree root; unset ⇒ shared-tree branch switching. */
  readonly worktreesDir?: string
  /** Shell command run in a fresh worktree after creation. */
  readonly worktreeSetup?: string
  /** Extra REVIEW lenses; each runs one more focused review pass. */
  readonly reviewLenses: readonly string[]
}

/** Construct a LoopState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agent-loop-task approve-plan`. */
export const resumeAtBuild = (goal: string, task: TaskRef, plan: string): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: { plan },
  task,
})

/** Construct a LoopState entering at the PLAN stage, for a claimed `queued/`
 *  task. `priorPlan` carries a rejected/capped plan on a replan so the new
 *  plan addresses why the old one failed instead of repeating it. */
export const startAtPlan = (goal: string, task: TaskRef, priorPlan?: string): LoopState => ({
  goal,
  stage: "plan",
  iteration: 0,
  artifacts: priorPlan ? { plan: priorPlan } : {},
  task,
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
