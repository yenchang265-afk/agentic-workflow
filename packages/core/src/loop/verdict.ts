/**
 * Verdict types for the loop's two check stages (VERIFY and REVIEW), plus a
 * parser for the human-readable verdict line they end their transcripts with:
 *   LOOP_VERIFY: PASS / LOOP_VERIFY: FAIL
 *   LOOP_REVIEW: PASS / LOOP_REVIEW: FAIL
 *
 * The text line is **diagnostic only**. The authoritative verdict channel is
 * the `loop_verdict` plugin tool (see driver.ts) — free text is untrusted:
 * a stage quoting its own contract, or repo content echoed into the output,
 * must never be able to flip the loop's control flow. The driver uses
 * `parseVerdict` only to log a discrepancy when a stage wrote a text verdict
 * but never called the tool (which the loop counts as FAIL).
 *
 * Pure and total: returns the last verdict found for the given tag, or null
 * when none is present.
 */

/**
 * PASS/FAIL decide the loop's control flow; ERROR means the check itself
 * could not run (broken environment, missing test runner) — the loop stops
 * for a human instead of burning a re-plan/re-build iteration on it.
 */
export type Verdict = "PASS" | "FAIL" | "ERROR"

/** Per-acceptance-criterion result carried alongside a verdict (optional). */
export interface CriterionResult {
  readonly criterion: string
  readonly pass: boolean
}

/**
 * A verdict plus the optional structured reasons the check stage recorded via
 * the `loop_verdict` tool. `reason`/`criteria` steer the *next iteration's
 * prompt* — never control flow, which remains `verdict` alone (same trust
 * level as the verdict itself, since they arrive through the same tool call).
 */
export interface VerdictRecord {
  readonly verdict: Verdict
  readonly reason?: string
  readonly criteria?: readonly CriterionResult[]
}

/**
 * Combine several review-lens verdicts into one: any ERROR wins (the check
 * couldn't run), else any FAIL/missing wins, else PASS. A missing verdict
 * (null) counts as FAIL — never a stall — as a conservative default; callers
 * that can tell "the lens ran but its verdict channel broke" apart from a
 * genuine FAIL must screen those nulls into ERROR before combining (the
 * OpenCode driver does — a broken channel must not burn a rebuild iteration).
 * Pure.
 */
export const worstOf = (verdicts: readonly (Verdict | null)[]): Verdict => {
  if (verdicts.some((v) => v === "ERROR")) return "ERROR"
  if (verdicts.some((v) => v !== "PASS")) return "FAIL"
  return "PASS"
}

/** Render the failed criteria as a prompt block for the next iteration, or "". Pure. */
export const failedCriteriaBlock = (record: VerdictRecord | null): string => {
  const failed = record?.criteria?.filter((c) => !c.pass) ?? []
  const lines: string[] = []
  if (record?.reason) lines.push(`Verdict reason: ${record.reason}`)
  if (failed.length) {
    lines.push("Failed criteria (from loop_verdict):")
    for (const c of failed) lines.push(`- ${c.criterion}`)
  }
  return lines.join("\n")
}

/** The verdict tags emitted by the loop's check stages. */
export const LOOP_VERIFY_TAG = "LOOP_VERIFY"
export const LOOP_REVIEW_TAG = "LOOP_REVIEW"

/**
 * The mandatory verdict-contract paragraph appended to every CHECK stage's
 * composed prompt (see engine.ts `composePrompt`). The contract normally
 * lives in the loop-verify/loop-review agent definitions, but a mis-resolved
 * subagent binding or a stripped tool allowlist silently loses it — and the
 * stage then "passes" in prose while the loop records FAIL. Carrying the
 * contract in the prompt itself makes it survive any dispatch path, on both
 * hosts. Pure.
 */
export const verdictContractBlock = (stage: string): string =>
  [
    "MANDATORY VERDICT: before you finish, record your verdict by calling the `loop_verdict` tool",
    "(on Claude Code it appears as `mcp__agentic-loop__loop_verdict` or, plugin-bundled,",
    "`mcp__plugin_agentic-loop_agentic-loop__loop_verdict`)",
    `exactly once, with stage: "${stage}", verdict: "PASS" | "FAIL" | "ERROR", and a one-line reason on FAIL/ERROR.`,
    "A verdict written only in prose is IGNORED and the loop records this stage as a failure.",
    "If the loop_verdict tool is not in your tool list, state that explicitly in your final message and finish.",
  ].join(" ")

/**
 * The scope fence appended to every WORK stage's composed prompt, the
 * counterpart to `verdictContractBlock` (see engine.ts `composePrompt`).
 *
 * The state machine only advances when a stage's turn ENDS, so a work stage
 * that keeps going — building, then verifying and reviewing its own output in
 * the same turn — does that work while the loop still sits at its own stage.
 * Its `loop_verdict` calls are rejected ("the loop is at build, not verify"),
 * the real check stage then re-runs everything, and the turn's final message
 * claims a PASS and a folder move that never happened. Naming the boundary in
 * the prompt is the only fence that survives every dispatch path, on both
 * hosts. Pure.
 */
export const workScopeBlock = (stage: string): string =>
  [
    `STAGE SCOPE: you are running the ${stage} stage only.`,
    `Finish your turn as soon as ${stage}'s own work is done and summarize what you did —`,
    "what happens next is the loop's decision, taken after your turn ends: it fires the next stage, parks for a human, or finishes.",
    "Do not run a later stage's work (verification, review, shipping) inside this turn:",
    "it is redone anyway, and it runs while the loop is still recorded at this stage.",
    "Never call the `loop_verdict` tool — it is rejected outside its own check stage and the rejection is audited as stage drift.",
    "Never state that the task moved, that a check passed, or that the loop finished — only the loop moves work.",
  ].join(" ")

/**
 * The audit note appended to the task file when `loop_verdict` arrives from a
 * stage the loop is not at. The rejection itself is returned only to the
 * calling agent, so without this note the drift is invisible until a later
 * stage behaves oddly (a re-run check, a fabricated PASS). Pure. Hosts append
 * it at most once per stage attempt — a drifting agent may call repeatedly.
 */
export const stageDriftNote = (activeStage: string, requested: string, verdict: Verdict | null): string =>
  `Stage drift: a ${requested.toUpperCase()} verdict${verdict ? ` (${verdict})` : ""} was recorded while the loop was at ` +
  `${activeStage.toUpperCase()} — ignored. The ${activeStage.toUpperCase()} stage ran a later stage's work inside its own turn; ` +
  `its claims about that work are unverified and the loop re-ran the real stage.`

export const parseVerdict = (text: string, tag: string): Verdict | null => {
  if (!text) return null
  const re = new RegExp(`${tag}:\\s*(PASS|FAIL|ERROR)`, "gi")
  let last: Verdict | null = null
  for (const match of text.matchAll(re)) {
    const verdict = match[1]
    if (verdict) last = verdict.toUpperCase() as Verdict
  }
  return last
}
