/**
 * Parse the VERIFY stage's machine-readable verdict line out of its output.
 *
 * The verify subagent must end its response with exactly one of:
 *   LOOP_VERIFY: PASS
 *   LOOP_VERIFY: FAIL
 *
 * Pure and total: returns the last verdict found, or null when none is present
 * (which the loop treats as a failure to determine — i.e. not a PASS).
 */

export type Verdict = "PASS" | "FAIL"

const VERDICT_RE = /LOOP_VERIFY:\s*(PASS|FAIL)/gi

export const parseVerdict = (text: string): Verdict | null => {
  if (!text) return null
  let last: Verdict | null = null
  for (const match of text.matchAll(VERDICT_RE)) {
    const verdict = match[1]
    if (verdict) last = verdict.toUpperCase() as Verdict
  }
  return last
}
