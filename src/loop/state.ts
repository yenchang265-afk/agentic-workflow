import { parseVerdict } from "./verdict.ts"

/**
 * Loop state machine for the agentic loop (explore → plan → build → verify).
 *
 * The transition helpers here are **pure**: given a state (and config) they
 * return a new state plus an `Action` describing what the driver should do, and
 * never touch a client or the store. That keeps the loop logic unit-testable
 * without opencode. The impure orchestration lives in `driver.ts`.
 */

export type Stage = "explore" | "plan" | "build" | "verify"

/** The stages in loop order. */
export const STAGES: readonly Stage[] = ["explore", "plan", "build", "verify"]

export interface LoopState {
  /** The goal the loop is driving toward. */
  readonly goal: string
  /** The stage currently running or most recently completed. */
  readonly stage: Stage
  /** 0-based loop iteration; incremented on a verify FAIL re-plan. */
  readonly iteration: number
  /** True while paused at the human plan-approval gate. */
  readonly paused: boolean
  /** Captured output text per completed stage, used to thread context forward. */
  readonly artifacts: Readonly<Partial<Record<Stage, string>>>
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
}

/** Fresh state for a new loop; the driver fires explore right after creating it. */
export const createState = (goal: string): LoopState => ({
  goal,
  stage: "explore",
  iteration: 0,
  paused: false,
  artifacts: {},
})

const withArtifact = (state: LoopState, stage: Stage, output: string): LoopState => ({
  ...state,
  artifacts: { ...state.artifacts, [stage]: output },
})

/** Compose the prompt threaded into a stage command: goal + relevant prior artifacts. */
export const composeArgs = (state: LoopState, target: Stage): string => {
  const a = state.artifacts
  const parts: string[] = [`Goal: ${state.goal}`]
  if (target === "plan") {
    if (a.explore) parts.push(`Explore findings:\n${a.explore}`)
    if (a.plan) parts.push(`Previous plan:\n${a.plan}`)
    if (a.verify) parts.push(`Verify failure to address:\n${a.verify}`)
  } else if (target === "build") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
  } else if (target === "verify") {
    if (a.plan) parts.push(`Plan & acceptance criteria:\n${a.plan}`)
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
    case "explore":
      return fire(s, "plan")

    case "plan":
      if (config.gateBeforeBuild) {
        return {
          state: { ...s, paused: true },
          action: { kind: "gate", message: "Plan ready — review it, then run /loop go to build." },
        }
      }
      return fire(s, "build")

    case "build":
      return fire(s, "verify")

    case "verify": {
      if (parseVerdict(output) === "PASS") {
        return {
          state: s,
          action: { kind: "done", message: "✓ Loop done — verify passed. Review the diff and open a PR." },
        }
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
  }
}

/** Resume from the plan-approval gate (`/loop go`): proceed to build. */
export const resume = (state: LoopState): { state: LoopState; action: Action } => {
  if (!state.paused) return { state, action: { kind: "noop" } }
  return fire(state, "build")
}

// --- In-memory store (lost on opencode restart; see README known limitations) ---

const store = new Map<string, LoopState>()

export const getLoop = (sessionID: string): LoopState | undefined => store.get(sessionID)
export const setLoop = (sessionID: string, state: LoopState): void => void store.set(sessionID, state)
export const clearLoop = (sessionID: string): boolean => store.delete(sessionID)
export const hasLoop = (sessionID: string): boolean => store.has(sessionID)
