/**
 * Deterministic context budgets for stage prompts. Pure — no shell, clock, or fs.
 *
 * Budgets are in CHARACTERS, not tokens: the core has no tokenizer, tokenization
 * is model-specific, and a byte budget is exact, testable, and pure. Convert with
 * roughly 3.5–4 characters per token for English prose and code — a 24,000-char
 * ceiling is ~6–7k tokens.
 *
 * Clamping is the only compression here. Asking a model to summarize an artifact
 * would add a failure mode, a latency cost, and a second weak-model dependency on
 * exactly the path these budgets exist to protect.
 */

/**
 * Marker left in place of elided text. Deliberately unmistakable: a clamped
 * artifact must never read as a complete one to a model that will act on it.
 */
export const ELISION = (n: number): string => `\n\n[… ${n} characters elided by the stage context budget …]\n\n`

/** A body that is nothing but an elision marker — see the degenerate case in `clampWithStats`. */
const ONLY_ELISION = /^\s*\[… \d+ characters elided by the stage context budget …\]\s*$/

/**
 * Clamp `text` to at most `limit` characters, preserving both head and tail, and
 * report how many characters were dropped.
 *
 * `Infinity` — the default when nothing is configured — is the identity, which is
 * what makes an unconfigured loop byte-identical to one with no budgets at all.
 *
 * Head AND tail, not a head truncate: a check stage opens with its verdict
 * rationale and closes with the concrete failing assertions, and a re-build needs
 * both ends. A plain head-slice reliably throws away the half that names the
 * failing file and line.
 */
export const clampWithStats = (text: string, limit: number): { text: string; elided: number } => {
  if (!Number.isFinite(limit) || text.length <= limit) return { text, elided: 0 }
  // Already nothing but a marker: maximally clamped, and no limit can shrink it
  // further. Re-clamping must not restate the count against the marker's own
  // length — clamping stays idempotent even in the degenerate case.
  if (ONLY_ELISION.test(text)) return { text, elided: 0 }

  // The marker counts against the limit (so the result really fits, and so
  // re-clamping is a no-op), but its own length depends on the digit count of the
  // elided total, which depends on the marker's length. Two passes converge: the
  // first estimate can only shift the digit count by one, and the second is
  // computed against that estimate.
  let elided = text.length - Math.max(0, limit)
  for (let pass = 0; pass < 2; pass++) {
    const room = Math.max(0, limit - ELISION(elided).length)
    elided = text.length - room
  }

  const room = Math.max(0, limit - ELISION(elided).length)
  if (room <= 0) return { text: ELISION(text.length).trim(), elided: text.length }

  // Favor the tail on an odd split: it carries the failing assertion.
  const head = Math.floor(room / 2)
  const tail = room - head
  return { text: `${text.slice(0, head)}${ELISION(elided)}${text.slice(text.length - tail)}`, elided }
}

/** `clampWithStats` without the count, for call sites that only need the text. Pure. */
export const clamp = (text: string, limit: number): string => clampWithStats(text, limit).text
