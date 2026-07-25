import type { LoadedManifest, StageDef } from "../manifest/schema.js"
import { stageDef } from "../manifest/schema.js"
import { renderPrompt, type TemplateContext } from "../manifest/template.js"
import { resolveComposeHook } from "../manifest/registry.js"
import type { Action, Config, WorkflowState } from "./state.js"
import { clampWithStats } from "./budget.js"
import { contextFor } from "../config.js"
import {
  verdictContractBlock,
  verdictFeedbackBlock,
  workScopeBlock,
  type Verdict,
  type VerdictRecord,
} from "./verdict.js"

/**
 * The manifest-interpreted state machine: given a workflow kind's manifest, the
 * current state, and a completed stage's output (+ verdict for check stages),
 * decide what happens next. **Pure** — the successor to the hardcoded
 * engineering-only `advanceOnIdle`, with the pipeline shape, retry budget,
 * and messages coming from the manifest instead of a switch.
 */

/**
 * Ceiling on the exempt structured prefix of an artifact (see `promptContext`).
 * `verdictFeedbackBlock` is bounded by construction — one line per failed
 * criterion, one per blocking finding — but not bounded in the worst case, and an
 * unbounded exemption would defeat the budget it sits inside.
 */
export const EXEMPT_MAX = 4_000

/**
 * Store a completed stage's output as its artifact, fusing the structured verdict
 * feedback ahead of the prose.
 *
 * Core owns the fusion (the hosts each used to do it themselves) so it can also
 * record WHERE the prose starts — `feedback` — which is what lets `promptContext`
 * budget the prose without touching the structured block. The fused text is what
 * lands in the artifact and therefore in the snapshot, so a lost `feedback` key
 * degrades to "the block is clamped too", never to "the block is missing".
 */
const withArtifact = (state: WorkflowState, stage: string, output: string, block: string): WorkflowState => {
  const text = block ? `${block}\n\n${output}` : output
  return {
    ...state,
    artifacts: { ...state.artifacts, [stage]: text },
    ...(block ? { feedback: { ...state.feedback, [stage]: block } } : {}),
  }
}

const withoutArtifacts = (state: WorkflowState, stages: readonly string[]): WorkflowState => {
  if (stages.length === 0) return state
  const artifacts = Object.fromEntries(Object.entries(state.artifacts).filter(([k]) => !stages.includes(k)))
  // Drop the matching seams too: a seam whose artifact is gone would otherwise
  // ride along in every later snapshot and could mis-exempt a re-created artifact.
  const feedback = state.feedback
    ? Object.fromEntries(Object.entries(state.feedback).filter(([k]) => !stages.includes(k)))
    : undefined
  return { ...state, artifacts, ...(feedback ? { feedback } : {}) }
}

/**
 * Apply a stage's per-artifact character budgets, exempting the structured
 * verdict block at the head of an artifact.
 *
 * The exemption is anchored on an exact `startsWith` against the seam recorded by
 * `withArtifact` — no sentinel embedded in the text, which would be forgeable by
 * an agent whose prose is in the same string. If the seam no longer matches (a
 * host stopped prepending, a snapshot predates the seam) the artifact is clamped
 * whole: lossy, never unbounded.
 */
const budgetedArtifacts = (
  state: WorkflowState,
  budgets: Readonly<Record<string, number>>,
): { artifacts: Record<string, string>; elided: number } => {
  let elided = 0
  const artifacts: Record<string, string> = {}
  for (const [key, text] of Object.entries(state.artifacts)) {
    const limit = budgets[key] ?? Number.POSITIVE_INFINITY
    const seam = state.feedback?.[key] ?? ""
    if (!seam || !text.startsWith(seam)) {
      const c = clampWithStats(text, limit)
      artifacts[key] = c.text
      elided += c.elided
      continue
    }
    const head = clampWithStats(seam, EXEMPT_MAX)
    const c = clampWithStats(text.slice(seam.length), limit)
    artifacts[key] = `${head.text}${c.text}`
    elided += head.elided + c.elided
  }
  return { artifacts, elided }
}

/**
 * The template context a stage prompt renders against. Everything derivable
 * from the state is precomputed here (diff command, worktree pinning
 * paragraph) so ordinary workflow kinds need no compose hooks.
 */
export const promptContext = (
  state: WorkflowState,
  budgets: Readonly<Record<string, number>> = {},
): TemplateContext => {
  const accept = state.task?.acceptance ?? []
  const wt = state.git?.worktree
  const diffCmd = state.git
    ? wt
      ? `git -C ${wt} diff ${state.git.base}...${state.git.branch}`
      : `git diff ${state.git.base}...${state.git.branch}`
    : ""
  return {
    goal: state.goal,
    iteration: String(state.iteration),
    // Code-platform switches for prompt templates ({{#platform.ado}}…); absent platform ⇒ github.
    platform: {
      github: state.platform !== "ado",
      ado: state.platform === "ado",
    },
    task: state.task ? { id: state.task.id, path: state.task.path } : undefined,
    acceptance: accept.length ? { bullets: accept.map((c) => `- ${c}`).join("\n") } : undefined,
    artifacts: budgetedArtifacts(state, budgets).artifacts,
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

/**
 * Render one stage's prompt from its template source and context, appending the
 * stage's contract block. Every stage carries its contract in the prompt
 * itself, so it survives a mis-bound subagent or a stripped tool allowlist
 * (see verdict.ts): check stages the mandatory verdict contract, work stages
 * the scope fence that keeps them from running later stages inside their own
 * turn.
 *
 * This is the LENIENT primitive: it takes the template and context directly,
 * so callers that cannot satisfy `composePrompt`'s preconditions — an unsaved
 * manifest whose prompts aren't on disk, a compose hook no host has registered
 * (the hub's creator preview) — compose the exact same output without the
 * throw. `composePrompt` layers loading and hook resolution on top.
 */
export const composeStagePrompt = (def: StageDef, tpl: string, ctx: TemplateContext): string => {
  const rendered = renderPrompt(tpl, ctx)
  return def.kind === "check"
    ? `${rendered}\n\n${verdictContractBlock(def.name, def.requiredAxes)}`
    : `${rendered}\n\n${workScopeBlock(def.name)}`
}

/**
 * Render the prompt threaded into `target`'s stage command, and report how much
 * artifact text the stage's context budget elided.
 *
 * `config` is optional so every existing call site keeps compiling and an omitted
 * one means "unbounded" — the same thing an unset knob means. A host that fires a
 * stage should pass it; the fire-site tests pin that, since a forgotten argument
 * is otherwise silent.
 *
 * Note a compose hook runs AFTER the budget is applied and receives the raw
 * state, so a hook is inside the trust boundary and owns its own budget.
 */
export const composePromptWithStats = (
  loaded: LoadedManifest,
  state: WorkflowState,
  target: string,
  config?: Config,
): { prompt: string; elided: number } => {
  const def = stageDef(loaded.manifest, target)
  const tpl = loaded.prompts[def.name]
  if (tpl === undefined) throw new Error(`workflow kind "${loaded.manifest.kind}" has no prompt loaded for stage "${def.name}"`)
  const budgets = config ? contextFor(config, loaded.manifest.kind, def) : {}
  const { elided } = budgetedArtifacts(state, budgets)
  const base = promptContext(state, budgets)
  const hookRef = loaded.manifest.hooks.compose[def.name]
  const ctx = hookRef ? resolveComposeHook(hookRef)(base, state) : base
  return { prompt: composeStagePrompt(def, tpl, ctx), elided }
}

/** Render the prompt threaded into `target`'s stage command. */
export const composePrompt = (loaded: LoadedManifest, state: WorkflowState, target: string, config?: Config): string =>
  composePromptWithStats(loaded, state, target, config).prompt

const fireAt = (
  loaded: LoadedManifest,
  state: WorkflowState,
  target: string,
  config?: Config,
): { state: WorkflowState; action: Action } => {
  const next = { ...state, stage: target }
  const { prompt, elided } = composePromptWithStats(loaded, next, target, config)
  return {
    state: next,
    action: { kind: "fire", stage: target, arguments: prompt, ...(elided ? { promptElided: elided } : {}) },
  }
}

/** The first step to drive for a freshly-constructed state — fires its own stage. */
export const firstStep = (
  loaded: LoadedManifest,
  state: WorkflowState,
  config?: Config,
): { state: WorkflowState; action: Action } => {
  const { prompt, elided } = composePromptWithStats(loaded, state, state.stage, config)
  return {
    state,
    action: { kind: "fire", stage: state.stage, arguments: prompt, ...(elided ? { promptElided: elided } : {}) },
  }
}

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
  record: VerdictRecord | null = null,
): { state: WorkflowState; action: Action } => {
  const { manifest } = loaded
  // Fuse the machine-recorded failure reasons ahead of the stage's prose so the
  // next iteration leads with what actually failed. Owned here, not by each host,
  // so the seam between the two is recorded and the budget can spare the block.
  const s = withArtifact(state, state.stage, output, verdictFeedbackBlock(record))
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
        return fireAt(loaded, next, effect.stage, config)
      }
      return fireAt(loaded, withoutArtifacts(s, effect.dropArtifacts), effect.stage, config)
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
