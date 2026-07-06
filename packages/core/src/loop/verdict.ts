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
 * (null) counts as FAIL — never a stall. Pure.
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
