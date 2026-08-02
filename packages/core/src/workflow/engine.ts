import type { LoadedManifest, StageDef, WorkflowManifest } from "../manifest/schema.js"
import { stageDef } from "../manifest/schema.js"
import { renderPrompt, type TemplateContext } from "../manifest/template.js"
import { resolveComposeHook } from "../manifest/registry.js"
import type { Action, AttemptRecord, Config, WorkflowState } from "./state.js"
import { stripPlanAndAuditTail } from "../task/plan-section.js"
import { clampWithStats } from "./budget.js"
import { anyFailed, checksBlock, type CheckResult } from "./checks.js"
import { contextFor, stagePasses } from "../config.js"
import {
  verdictContractBlock,
  verdictFeedbackBlock,
  workScopeBlock,
  type StagePass,
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

/**
 * Attach a stage's check results to the state. Pure — the HOST runs the
 * commands, the engine only carries them, which is what keeps `engine.ts` pure
 * while a stage prompt still gets to state exit codes as fact.
 */
export const withCheckResults = (
  state: WorkflowState,
  stage: string,
  results: readonly CheckResult[],
): WorkflowState => ({ ...state, checks: { ...state.checks, [stage]: results } })

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

/** Longest a ledger reason may be; a verdict reason can be a paragraph. */
const ATTEMPT_REASON_MAX = 200

/** How many attempts the ledger keeps — covers any realistic `maxIterations`. */
const ATTEMPTS_KEPT = 5

/** First line of `reason`, truncated — the ledger must not itself blow the budget. Pure. */
const attemptReason = (reason: string | undefined): string | undefined => {
  const line = reason?.split("\n")[0]?.trim()
  return line ? line.slice(0, ATTEMPT_REASON_MAX) : undefined
}

/** Append one counted iteration's outcome, keeping the last `ATTEMPTS_KEPT`. Pure. */
const withAttempt = (state: WorkflowState, stage: string, verdict: Verdict, record: VerdictRecord | null): WorkflowState => {
  const reason = attemptReason(record?.reason)
  const entry: AttemptRecord = { stage, iteration: state.iteration, verdict, ...(reason ? { reason } : {}) }
  return { ...state, attempts: [...(state.attempts ?? []), entry].slice(-ATTEMPTS_KEPT) }
}

/**
 * The iteration cap in force for a run of this manifest — the ONE resolution
 * both the stop decision in `advance` and the prompt's iteration-budget section
 * use, so the number an agent is told can never drift from the number the loop
 * stops at. Pure.
 */
export const iterationCap = (manifest: WorkflowManifest, config?: Config): number | undefined =>
  manifest.maxIterations ?? config?.maxIterations

/**
 * The template context a stage prompt renders against, plus how many characters
 * the stage's context budget elided. Everything derivable from the state is
 * precomputed here (diff command, worktree pinning paragraph) so ordinary
 * workflow kinds need no compose hooks.
 *
 * `goal` is rendered through `stripPlanAndAuditTail`: after PLAN, the persisted
 * body carries the plan section (already injected separately as
 * `artifacts.plan`) and the accreted audit tail, so rendering `state.goal` raw
 * puts the plan in every prompt twice and grows the goal with every run. The
 * strip is render-side only — `state.goal` and the snapshots keep the full
 * text — and it may additionally be clamped by a `goal` budget key
 * (`stageContext.<stage>.goal`), the one budget key that names no artifact.
 *
 * `cap` is the resolved iteration cap (`iterationCap`); it feeds the
 * `iterations` budget section. Omitted (a config-less caller, e.g. the hub's
 * preview with no manifest cap) ⇒ the section is undefined and drops.
 */
export const promptContextWithStats = (
  state: WorkflowState,
  budgets: Readonly<Record<string, number>> = {},
  cap?: number,
): { ctx: TemplateContext; elided: number } => {
  const accept = state.task?.acceptance ?? []
  const wt = state.git?.worktree
  // Undefined when the stage ran no checks, so `renderPrompt` drops the section
  // and a check-less prompt stays byte-identical to what it was before checks
  // existed. `failed` lets a template phrase itself differently on a red run.
  const ran = state.checks?.[state.stage]
  const checks = ran?.length ? { block: checksBlock(ran), failed: anyFailed(ran) } : undefined
  const diffCmd = state.git
    ? wt
      ? `git -C ${wt} diff ${state.git.base}...${state.git.branch}`
      : `git diff ${state.git.base}...${state.git.branch}`
    : ""
  const goal = clampWithStats(stripPlanAndAuditTail(state.goal), budgets["goal"] ?? Number.POSITIVE_INFINITY)
  const budgeted = budgetedArtifacts(state, budgets)
  const ctx: TemplateContext = {
    goal: goal.text,
    iteration: String(state.iteration),
    // The iteration budget, human-numbered (iteration 0 is "1"). Gated on a
    // counted re-fire having happened (`iteration > 0`): the first fire of every
    // stage stays byte-identical to the pre-budget prompt, and the message lands
    // where it matters — a re-build after a FAIL. `final` marks the iteration
    // whose failure will trip the cap, using exactly `advance`'s stop predicate.
    iterations:
      cap !== undefined && state.iteration > 0
        ? {
            human: String(state.iteration + 1),
            cap: String(cap),
            ...(state.iteration + 1 >= cap ? { final: true } : {}),
          }
        : undefined,
    // Code-platform switches for prompt templates ({{#platform.ado}}…); absent platform ⇒ github.
    platform: {
      github: state.platform !== "ado",
      ado: state.platform === "ado",
    },
    // Azure DevOps coordinates, so an ADO prompt can spell out the tool
    // arguments instead of telling the agent to derive them.
    ado: state.ado ? { project: state.ado.project, repository: state.ado.repository } : undefined,
    task: state.task ? { id: state.task.id, path: state.task.path } : undefined,
    // The plan gate's rejection reason, threaded from the task file at claim
    // (`extractReplanReason`). Undefined when no rejection is pending, so the
    // section drops and a first-plan prompt is unchanged.
    replan: state.replan ? { reason: state.replan.reason } : undefined,
    acceptance: accept.length ? { bullets: accept.map((c) => `- ${c}`).join("\n") } : undefined,
    artifacts: budgeted.artifacts,
    checks,
    // Pre-rendered: TemplateValue has no arrays. Undefined when empty so
    // `renderPrompt` drops the section and a first-iteration prompt is unchanged.
    attempts: state.attempts?.length
      ? {
          lines: state.attempts
            .map((a) => `- iteration ${a.iteration + 1} (${a.stage} ${a.verdict})${a.reason ? `: ${a.reason}` : ""}`)
            .join("\n"),
        }
      : undefined,
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
  return { ctx, elided: budgeted.elided + goal.elided }
}

/** `promptContextWithStats` without the elision count, for render-only callers. Pure. */
export const promptContext = (
  state: WorkflowState,
  budgets: Readonly<Record<string, number>> = {},
  cap?: number,
): TemplateContext => promptContextWithStats(state, budgets, cap).ctx

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
/**
 * The one contract a stage's passes share. Passes are homogeneous — `stagePasses`
 * returns lens passes, axis passes, or a single pass, never a mix — so the first
 * pass's mode names the whole stage's. Pure.
 */
const passMode = (passes: readonly StagePass[]): "single" | "axis" | "lens" =>
  passes.some((p) => p.mode === "axis") ? "axis" : passes.some((p) => p.mode === "lens") ? "lens" : "single"

export const composeStagePrompt = (
  def: StageDef,
  tpl: string,
  ctx: TemplateContext,
  // Defaulted from the stage itself so a config-less caller (the hub's creator
  // preview) shows what the manifest declares. `composePromptWithStats` passes
  // the EFFECTIVE mode instead, because config can turn fan-out on or off and
  // `reviewLenses` can replace it with lens passes entirely.
  mode: "single" | "axis" | "lens" = def.fanout === "axis" ? "axis" : "single",
): string => {
  const rendered = renderPrompt(tpl, ctx)
  return def.kind === "check"
    ? `${rendered}\n\n${verdictContractBlock(def.name, def.requiredAxes, mode, def.requireEvidence)}`
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
  const { ctx: base, elided } = promptContextWithStats(state, budgets, iterationCap(loaded.manifest, config))
  const hookRef = loaded.manifest.hooks.compose[def.name]
  const ctx = hookRef ? resolveComposeHook(hookRef)(base, state) : base
  // The EFFECTIVE mode, not the manifest's: a configured `reviewLenses` beats a
  // declared per-axis fan-out, and the contract must describe the passes that
  // will actually run — otherwise a lens pass is told to report one axis it was
  // never given, or an axis pass is told to report all five.
  const mode = config ? passMode(stagePasses(config, loaded.manifest.kind, def)) : undefined
  return { prompt: composeStagePrompt(def, tpl, ctx, mode), elided }
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
      ? // A work stage normally has exactly one exit: it did the work, fire the
        // next stage. The one exception is a stage that reports it CANNOT do the
        // work at all — an approved plan that turns out to be impossible. Without
        // this arm, saying so changed nothing: the next check stage fired anyway,
        // failed, re-fired the work stage, and the loop burned every iteration to
        // surface what the first pass already knew. Routed only when the manifest
        // opts in with an `onError` arm, so kinds that declare none behave exactly
        // as before. The signal reaches here as ERROR from the host's
        // `workflow_blocked` tool, NOT from `workflow_verdict` — a work stage is
        // still forbidden to record a verdict on its own work.
        (verdict === "ERROR" ? (t?.onError ?? t?.onDone) : t?.onDone)
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
        const cap = iterationCap(manifest, config) ?? config.maxIterations
        if (s.iteration + 1 >= cap) {
          const message = (effect.capMessage ?? `✗ Loop stopped after {maxIterations} iterations.`).replaceAll(
            "{maxIterations}",
            String(cap),
          )
          return { state: s, action: { kind: "stop", message } }
        }
        // Recorded here, on the counted re-fire, not on every check completion:
        // a verdict-channel retry must not inflate the ledger.
        const logged = withAttempt(s, s.stage, verdict ?? "FAIL", record)
        const next = { ...withoutArtifacts(logged, effect.dropArtifacts), iteration: s.iteration + 1 }
        return fireAt(loaded, next, effect.stage, config)
      }
      return fireAt(loaded, withoutArtifacts(s, effect.dropArtifacts), effect.stage, config)
    }
    case "park":
      return { state: s, action: { kind: "park", message: effect.message, toStatus: effect.toStatus } }
    case "done":
      return { state: s, action: { kind: "done", message: effect.message, toStatus: effect.toStatus } }
    case "stop":
      // A stop reached via a CHECK stage's ERROR verdict is an `onError` transition — a
      // transient environment/tooling failure the manifest asks to retry on the next poll,
      // NOT a genuine exhaustion. Mark it retryable so the work source leaves the
      // target/head claimable instead of suppressing it forever (C2). The iteration-cap
      // stop above and the no-transition fail-safe stay unmarked ⇒ recorded as failed
      // attempts.
      //
      // A WORK stage's ERROR is the opposite kind of thing: it reports that the approved
      // plan cannot be implemented, which no amount of re-polling fixes. Leaving it
      // retryable would hand the task straight back to the watcher, which would re-claim
      // it and re-derive the same refusal forever. It needs a human (replan), so it stays
      // unmarked and is recorded as a failed attempt.
      return {
        state: s,
        action: {
          kind: "stop",
          message: effect.message,
          ...(verdict === "ERROR" && def.kind === "check" ? { retryable: true } : {}),
        },
      }
  }
}
