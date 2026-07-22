import type { LoadedManifest } from "../manifest/schema.js"
import { stageDef } from "../manifest/schema.js"
import { renderPrompt, type TemplateContext } from "../manifest/template.js"
import { resolveComposeHook } from "../manifest/registry.js"
import type { Action, Config, WorkflowState } from "./state.js"
import { verdictContractBlock, workScopeBlock, type Verdict } from "./verdict.js"

/**
 * The manifest-interpreted state machine: given a workflow kind's manifest, the
 * current state, and a completed stage's output (+ verdict for check stages),
 * decide what happens next. **Pure** — the successor to the hardcoded
 * engineering-only `advanceOnIdle`, with the pipeline shape, retry budget,
 * and messages coming from the manifest instead of a switch.
 */

const withArtifact = (state: WorkflowState, stage: string, output: string): WorkflowState => ({
  ...state,
  artifacts: { ...state.artifacts, [stage]: output },
})

const withoutArtifacts = (state: WorkflowState, stages: readonly string[]): WorkflowState => {
  if (stages.length === 0) return state
  const artifacts = Object.fromEntries(Object.entries(state.artifacts).filter(([k]) => !stages.includes(k)))
  return { ...state, artifacts }
}

/**
 * The template context a stage prompt renders against. Everything derivable
 * from the state is precomputed here (diff command, worktree pinning
 * paragraph) so ordinary workflow kinds need no compose hooks.
 */
export const promptContext = (state: WorkflowState): TemplateContext => {
  const accept = state.task?.acceptance ?? []
  const wt = state.git?.worktree
  const diffCmd = state.git
    ? wt
      ? `git -C ${wt} diff ${state.git.base}...${state.git.branch}`
      : `git diff ${state.git.base}...${state.git.branch}`
    : ""
  // Absent platformAccess falls back to "rest", NOT the config default "az":
  // a snapshot without the stamp was claimed by curl-era code whose stage
  // markers allowlist curl — rendering az/mcp commands would contradict them.
  const access = state.platformAccess ?? "rest"
  return {
    goal: state.goal,
    iteration: String(state.iteration),
    // Code-platform switches for prompt templates ({{#platform.ado}}…); absent platform ⇒ github.
    platform: {
      github: state.platform !== "ado",
      ado: state.platform === "ado",
      adoAccess: {
        rest: access === "rest",
        az: access === "az",
        mcp: access === "mcp",
      },
    },
    task: state.task ? { id: state.task.id, path: state.task.path } : undefined,
    acceptance: accept.length ? { bullets: accept.map((c) => `- ${c}`).join("\n") } : undefined,
    artifacts: { ...state.artifacts },
    git: state.git
      ? { base: state.git.base, branch: state.git.branch, worktree: wt ?? "", diffCmd }
      : undefined,
    worktree: wt
      ? {
          path: wt,
          instructions:
            `Worktree: this loop's isolated checkout is ${wt} — every file you read, edit, or ` +
            `test lives THERE, not in the repo root. Use absolute paths under it for edit/read; prefix every ` +
            `shell command with \`cd ${wt} && \` (or use \`git -C ${wt} …\`). ` +
            `Never modify anything outside it.`,
        }
      : undefined,
  }
}

/** Render the prompt threaded into `target`'s stage command. */
export const composePrompt = (loaded: LoadedManifest, state: WorkflowState, target: string): string => {
  const def = stageDef(loaded.manifest, target)
  const tpl = loaded.prompts[def.name]
  if (tpl === undefined) throw new Error(`workflow kind "${loaded.manifest.kind}" has no prompt loaded for stage "${def.name}"`)
  const hookRef = loaded.manifest.hooks.compose[def.name]
  const ctx = hookRef ? resolveComposeHook(hookRef)(promptContext(state), state) : promptContext(state)
  const rendered = renderPrompt(tpl, ctx)
  // Every stage carries its contract in the prompt itself, so it survives a
  // mis-bound subagent or a stripped tool allowlist (see verdict.ts): check
  // stages the mandatory verdict contract, work stages the scope fence that
  // keeps them from running later stages inside their own turn.
  return def.kind === "check"
    ? `${rendered}\n\n${verdictContractBlock(def.name, def.requiredAxes)}`
    : `${rendered}\n\n${workScopeBlock(def.name)}`
}

const fireAt = (loaded: LoadedManifest, state: WorkflowState, target: string): { state: WorkflowState; action: Action } => {
  const next = { ...state, stage: target }
  return { state: next, action: { kind: "fire", stage: target, arguments: composePrompt(loaded, next, target) } }
}

/** The first step to drive for a freshly-constructed state — fires its own stage. */
export const firstStep = (loaded: LoadedManifest, state: WorkflowState): { state: WorkflowState; action: Action } => ({
  state,
  action: { kind: "fire", stage: state.stage, arguments: composePrompt(loaded, state, state.stage) },
})

/**
 * Decide what to do when `state.stage` completed. `output` is that stage's
 * captured text (stored as its artifact). `verdict` is a check stage's
 * resolved verdict — recorded via the `workflow_verdict` tool, never parsed out
 * of `output` (free text is an untrusted channel; see verdict.ts). A missing
 * verdict on a check stage is a FAIL, not a stall — though hosts re-fire the
 * check once before feeding the miss in here (verdict-channel resilience).
 */
export const advance = (
  loaded: LoadedManifest,
  state: WorkflowState,
  config: Config,
  output: string,
  verdict: Verdict | null = null,
): { state: WorkflowState; action: Action } => {
  const { manifest } = loaded
  const s = withArtifact(state, state.stage, output)
  const def = stageDef(manifest, s.stage)
  const t = manifest.transitions[s.stage]
  const effect =
    def.kind === "work"
      ? t?.onDone
      : verdict === "PASS"
        ? t?.onPass
        : verdict === "ERROR"
          ? t?.onError
          : t?.onFail
  if (!effect) {
    // Unreachable for a schema-validated manifest; fail safe rather than hang.
    return { state: s, action: { kind: "stop", message: `✗ Loop stopped — no transition for stage "${s.stage}".` } }
  }

  switch (effect.kind) {
    case "fire": {
      if (effect.countIteration) {
        const cap = manifest.maxIterations ?? config.maxIterations
        if (s.iteration + 1 >= cap) {
          const message = (effect.capMessage ?? `✗ Loop stopped after {maxIterations} iterations.`).replaceAll(
            "{maxIterations}",
            String(cap),
          )
          return { state: s, action: { kind: "stop", message } }
        }
        const next = { ...withoutArtifacts(s, effect.dropArtifacts), iteration: s.iteration + 1 }
        return fireAt(loaded, next, effect.stage)
      }
      return fireAt(loaded, withoutArtifacts(s, effect.dropArtifacts), effect.stage)
    }
    case "park":
      return { state: s, action: { kind: "park", message: effect.message, toStatus: effect.toStatus } }
    case "done":
      return { state: s, action: { kind: "done", message: effect.message, toStatus: effect.toStatus } }
    case "stop":
      // A stop reached via the ERROR verdict is an `onError` transition — a transient
      // environment/tooling failure the manifest asks to retry on the next poll, NOT a
      // genuine exhaustion. Mark it retryable so the work source leaves the target/head
      // claimable instead of suppressing it forever (C2). The iteration-cap stop above
      // and the no-transition fail-safe stay unmarked ⇒ recorded as failed attempts.
      return { state: s, action: { kind: "stop", message: effect.message, ...(verdict === "ERROR" ? { retryable: true } : {}) } }
  }
}
