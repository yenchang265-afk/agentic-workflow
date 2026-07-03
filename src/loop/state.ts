import { LOOP_REVIEW_TAG, LOOP_VERIFY_TAG, parseVerdict } from "./verdict.ts"

/**
 * Loop state machine for the agentic loop:
 *
 *   plan → [gate] → build → verify → review
 *
 * The transition helpers here are **pure**: given a state (and config) they
 * return a new state plus an `Action` describing what the driver should do, and
 * never touch a client or the store. That keeps the loop logic unit-testable
 * without opencode. The impure orchestration lives in `driver.ts`.
 *
 * Two check stages can fail and loop back: a VERIFY FAIL re-plans (the plan
 * itself may be wrong); a REVIEW FAIL re-builds (the plan was fine, the
 * implementation wasn't). Both share one iteration counter and cap.
 *
 * PLAN is the **planning** phase — approving the plan gate parks it as a
 * backlog task rather than continuing into BUILD in the same session (see
 * `driver.ts`'s `parkApprovedPlan`). A `/loop watch` session later claims a
 * parked task and enters this same state machine directly at `build` via
 * `resumeAtBuild` — the transition logic below doesn't know or care whether
 * it got there via `createState`'s "plan" start or a claim's "build" start;
 * `composeArgs`/`advanceOnIdle` are identical either way.
 */

export type Stage = "plan" | "build" | "verify" | "review"

/** The stages in loop order. */
export const STAGES: readonly Stage[] = ["plan", "build", "verify", "review"]

/** Link to the backlog task driving the loop, when started from one. */
export interface TaskRef {
  readonly id: string
  /** Current on-disk path of the task file (updated as it moves between folders). */
  readonly path: string
  /** Acceptance criteria threaded into the plan/verify prompts. */
  readonly acceptance: readonly string[]
  /** Linked Azure DevOps work item, if the task has one. Threaded into every stage's context. */
  readonly azureId?: string
  readonly azureUrl?: string
}

export interface LoopState {
  /** The goal the loop is driving toward. */
  readonly goal: string
  /** The stage currently running or most recently completed. */
  readonly stage: Stage
  /** 0-based loop iteration; incremented on a verify FAIL re-plan or a review FAIL re-build. */
  readonly iteration: number
  /** True while paused at the plan→build human gate. */
  readonly paused: boolean
  /** Captured output text per completed stage, used to thread context forward. */
  readonly artifacts: Readonly<Partial<Record<Stage, string>>>
  /** Set when the loop was started from a backlog task; absent for free-text loops. */
  readonly task?: TaskRef
}

/** What the driver should do next. All state changes are returned, not applied. */
export type Action =
  | { readonly kind: "fire"; readonly stage: Stage; readonly arguments: string }
  | { readonly kind: "gate"; readonly message: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "stop"; readonly message: string }
  | { readonly kind: "noop" }

export interface Config {
  readonly maxIterations: number
  readonly gateBeforeBuild: boolean
  /** Repo-relative root of the task backlog (folders are statuses). */
  readonly tasksDir: string
}

/** Fresh state for a new loop; the driver fires plan right after creating it. */
export const createState = (goal: string, task?: TaskRef): LoopState => ({
  goal,
  stage: "plan",
  iteration: 0,
  paused: false,
  artifacts: {},
  ...(task ? { task } : {}),
})

/** Reconstruct a LoopState paused at the plan gate for an already-planned
 *  task (e.g. `/loop task <id>` resuming a persisted plan). */
export const resumeAtPlanGate = (goal: string, task: TaskRef, plan: string): LoopState => ({
  goal,
  stage: "plan",
  iteration: 0,
  paused: true,
  artifacts: { plan },
  task,
})

/** Reconstruct a LoopState entering execution directly at build, for a
 *  claimed in-progress task whose plan was already approved in a prior
 *  (planning) session. */
export const resumeAtBuild = (goal: string, task: TaskRef, plan: string): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  paused: false,
  artifacts: { plan },
  task,
})

const withArtifact = (state: LoopState, stage: Stage, output: string): LoopState => ({
  ...state,
  artifacts: { ...state.artifacts, [stage]: output },
})

/** Compose the prompt threaded into a stage command: goal + relevant prior artifacts. */
export const composeArgs = (state: LoopState, target: Stage): string => {
  const a = state.artifacts
  const accept = state.task?.acceptance ?? []
  const acceptBlock = (heading: string): string => `${heading}\n${accept.map((c) => `- ${c}`).join("\n")}`
  const parts: string[] = [`Goal: ${state.goal}`]
  const azureId = state.task?.azureId
  if (azureId) {
    const azureUrl = state.task?.azureUrl
    parts.push(`Linked Azure DevOps work item: #${azureId}${azureUrl ? ` — ${azureUrl}` : ""}`)
  }
  if (target === "plan") {
    if (a.plan) parts.push(`Previous plan:\n${a.plan}`)
    if (a.verify) parts.push(`Verify failure to address:\n${a.verify}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the plan must satisfy each):"))
  } else if (target === "build") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.review) parts.push(`Review feedback to address:\n${a.review}`)
  } else if (target === "verify") {
    if (a.plan) parts.push(`Plan & acceptance criteria:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the verdict must check each):"))
  } else if (target === "review") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
  }
  return parts.join("\n\n")
}

const fire = (state: LoopState, stage: Stage): { state: LoopState; action: Action } => ({
  state: { ...state, stage, paused: false },
  action: { kind: "fire", stage, arguments: composeArgs({ ...state, stage }, stage) },
})

/**
 * Decide what to do when the session goes idle after `state.stage` completed.
 * `output` is that stage's captured assistant text (stored as its artifact).
 */
export const advanceOnIdle = (
  state: LoopState,
  config: Config,
  output: string,
): { state: LoopState; action: Action } => {
  const s = withArtifact(state, state.stage, output)

  switch (s.stage) {
    case "plan":
      if (config.gateBeforeBuild) {
        const message =
          s.iteration === 0
            ? "Plan ready — review it, then run /loop go to approve and park it for execution."
            : "Plan ready — review it, then run /loop go to build."
        return { state: { ...s, paused: true }, action: { kind: "gate", message } }
      }
      return fire(s, "build")

    case "build":
      return fire(s, "verify")

    case "verify": {
      if (parseVerdict(output, LOOP_VERIFY_TAG) === "PASS") {
        return fire(s, "review")
      }
      // FAIL (or unparseable verdict): re-plan if budget remains, else stop.
      if (s.iteration + 1 < config.maxIterations) {
        const next = { ...s, iteration: s.iteration + 1 }
        return fire(next, "plan")
      }
      return {
        state: s,
        action: { kind: "stop", message: `✗ Loop stopped — verify failed after ${config.maxIterations} iterations.` },
      }
    }

    case "review": {
      if (parseVerdict(output, LOOP_REVIEW_TAG) === "PASS") {
        return {
          state: s,
          action: { kind: "done", message: "✓ Loop done — review passed. Ship it yourself." },
        }
      }
      // FAIL (or unparseable verdict): re-build if budget remains, else stop.
      if (s.iteration + 1 < config.maxIterations) {
        const next = { ...s, iteration: s.iteration + 1 }
        return fire(next, "build")
      }
      return {
        state: s,
        action: { kind: "stop", message: `✗ Loop stopped — review failed after ${config.maxIterations} iterations.` },
      }
    }
  }
}

/** Resume from a human gate (`/loop go`): proceed to whatever the paused stage gates into. */
export const resume = (state: LoopState): { state: LoopState; action: Action } => {
  if (!state.paused) return { state, action: { kind: "noop" } }
  if (state.stage === "plan") return fire(state, "build")
  return { state, action: { kind: "noop" } }
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
