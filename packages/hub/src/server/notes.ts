/**
 * Extract the audit blockquote trail from a task body. The loop appends
 * `> <event> [<ISO timestamp> by <actor>]` lines (task/store.ts auditNote);
 * plain `> <event>` blockquotes (no stamp) are kept too with empty at/by so
 * the timeline stays complete. Pure.
 *
 * Deliberately permissive, unlike core's `AUDIT_NOTE_LINE_RE` (task/store.ts),
 * which requires the stamp because it marks where the plan text ends — there a
 * stray blockquote would truncate the plan, here it only adds a timeline row.
 * Keep the two separate.
 */

/** Every audit-note line (`> …`) in a body, in order, trailing space normalized. Pure. */
export const noteLines = (body: string): string[] =>
  body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => /^>(\s|$)/.test(l))

/**
 * Note lines present in `before` but gone from `after`.
 *
 * `splitTaskBody` keeps the TRAILING audit run out of the editor entirely, but
 * an INTERLEAVED note — one an agent rewrite left above later prose — does reach
 * the textarea and can be deleted there. Comparing note lines turns a silent
 * audit-trail loss into a visible refusal naming the exact missing line.
 *
 * Set-based, so reordering the notes passes. That is a deliberate limit, not an
 * oversight: the trail's value is that each event is recorded, and each note
 * carries its own timestamp. Pure.
 */
export const missingNotes = (before: string, after: string): string[] => {
  const have = new Set(noteLines(after))
  return noteLines(before).filter((l) => !have.has(l))
}

/**
 * The audit trail parser now lives in core (`task/describe.ts`, design 55) so
 * the CLI hosts' `show` and this hub read one timeline. Re-exported unchanged.
 */
export { extractAuditNotes } from "@agentic-workflow/core/task/describe"
