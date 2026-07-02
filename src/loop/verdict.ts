/**
 * Parse a stage's machine-readable verdict line out of its output.
 *
 * VERIFY and REVIEW are the loop's two check stages; each must end its
 * response with exactly one of, respectively:
 *   LOOP_VERIFY: PASS / LOOP_VERIFY: FAIL
 *   LOOP_REVIEW: PASS / LOOP_REVIEW: FAIL
 *
 * Pure and total: returns the last verdict found for the given tag, or null
 * when none is present (which the loop treats as a failure to determine —
 * i.e. not a PASS).
 */

export type Verdict = "PASS" | "FAIL"

/** The verdict tags emitted by the loop's check stages. */
export const LOOP_VERIFY_TAG = "LOOP_VERIFY"
export const LOOP_REVIEW_TAG = "LOOP_REVIEW"

export const parseVerdict = (text: string, tag: string): Verdict | null => {
  if (!text) return null
  const re = new RegExp(`${tag}:\\s*(PASS|FAIL)`, "gi")
  let last: Verdict | null = null
  for (const match of text.matchAll(re)) {
    const verdict = match[1]
    if (verdict) last = verdict.toUpperCase() as Verdict
  }
  return last
}
