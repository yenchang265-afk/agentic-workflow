/**
 * Line-anchored markers of a task body's plan section and audit tail. Pure —
 * no Shell, clock, or fs — and a separate module from `store.ts` deliberately:
 * the workflow engine consumes these at prompt-render time and must not import
 * the store's Shell-bearing surface. `store.ts` re-exports what its callers
 * already use.
 */

/** Marks a task as planned, awaiting approval — appended to its body by `appendPlan`. */
export const PLAN_HEADING = "## Implementation Plan"

/**
 * Index of the LAST occurrence of `marker` at the start of a line, or -1.
 * Audit notes are whole lines (`appendNote` writes `\n> …\n`), so body text
 * merely QUOTING a marker mid-line — a pasted log, a task about this system —
 * must not read as lifecycle state. (A pasted full audit line still would;
 * markers-as-text is inherently heuristic, this closes the common case.) Pure.
 */
export const lastMarkerIndex = (body: string, marker: string): number => {
  for (let idx = body.lastIndexOf(marker); idx !== -1; idx = body.lastIndexOf(marker, idx - 1)) {
    if (idx === 0 || body[idx - 1] === "\n") return idx
  }
  return -1
}

/**
 * An audit-note line: `> …` closed by a bracketed stamp, the shape `auditNote`
 * gives every note a host appends (`[<ISO>]` or `[<ISO> by <actor>]`).
 *
 * Deliberately tighter than "any `> …` line": a plan may legitimately quote a
 * requirement as a blockquote, and treating that as the audit tail would silently
 * truncate the plan. The hub's `extractAuditNotes` is permissive on purpose (it
 * lists blockquotes for a timeline, where a false positive is cosmetic); this one
 * is a boundary, where a false positive loses plan text. The two must not be
 * merged. Pure.
 */
export const AUDIT_NOTE_LINE_RE = /^> .*\[[^\]\n]+\]\s*$/

/**
 * True when some STAMPED audit-note line of `body` matches `pattern`. Pure.
 *
 * The choke point for "lifecycle state is parsed only from stamped audit lines,
 * never from body prose". A task body is a document a human and a model both
 * write in — this backlog is full of tasks ABOUT the loop, whose bodies quote
 * the loop's own notes verbatim — so a bare `pattern.test(body)` reads a
 * quotation as a fact about the run. `store.ts`'s field parsers each re-derive
 * this rule against the LAST marker line; callers that only need "was this ever
 * recorded" get it here rather than writing a sixth copy (or, as the ship
 * gate's publish-record parsers did, no copy at all).
 */
export const auditNoteRecorded = (body: string, pattern: RegExp): boolean =>
  body.split("\n").some((line) => AUDIT_NOTE_LINE_RE.test(line) && pattern.test(line))

/** Offset of the first audit-note line at or after `from`, else `body.length`. Pure. */
export const auditTailIndex = (body: string, from: number): number => {
  for (let idx = from; idx < body.length; ) {
    const end = body.indexOf("\n", idx)
    const stop = end === -1 ? body.length : end
    if (AUDIT_NOTE_LINE_RE.test(body.slice(idx, stop))) return idx
    if (end === -1) break
    idx = end + 1
  }
  return body.length
}

/**
 * Index of the FIRST occurrence of `marker` at the start of a line, or -1.
 * Same line-anchoring rule as `lastMarkerIndex`. Pure.
 */
export const firstMarkerIndex = (body: string, marker: string): number => {
  for (let idx = body.indexOf(marker); idx !== -1; idx = body.indexOf(marker, idx + 1)) {
    if (idx === 0 || body[idx - 1] === "\n") return idx
  }
  return -1
}

/**
 * Goal text with every persisted plan section and the trailing audit-note run
 * removed. Pure.
 *
 * The engine renders `{{goal}}` from the whole task body, which after PLAN
 * contains the `## Implementation Plan` section — the exact text `extractPlan`
 * already injects as `artifacts.plan` — plus the accreted `> CLAIMED …` /
 * `> BUILD started …` audit tail. Rendering both means the plan enters every
 * stage prompt TWICE and the audit history grows the goal monotonically across
 * runs. This strips at render time only; the persisted body, `state.goal`, and
 * snapshots keep the full text.
 *
 * Slices at the FIRST heading, not the last: a PLAN pass that stacked instead
 * of replacing leaves superseded plans between the first heading and the live
 * one, and keeping them grew the goal by a full stale plan per replan cycle —
 * text that duplicates (an older version of) what `artifacts.plan` carries and
 * informs no stage. Then drops the trailing run of audit-note and blank lines.
 * Identity when the text has neither — every sitter-kind goal and every
 * plan-less task — so prompts without a plan stay byte-identical.
 */
export const stripPlanAndAuditTail = (text: string): string => {
  const planIdx = firstMarkerIndex(text, PLAN_HEADING)
  const head = planIdx === -1 ? text : text.slice(0, planIdx)
  const lines = head.split("\n")
  let end = lines.length
  let sawNote = false
  while (end > 0) {
    const line = lines[end - 1] as string
    if (AUDIT_NOTE_LINE_RE.test(line)) {
      sawNote = true
      end--
      continue
    }
    if (line.trim() === "") {
      end--
      continue
    }
    break
  }
  if (planIdx === -1 && !sawNote) return text
  return lines.slice(0, end).join("\n").trimEnd()
}

/**
 * A body with every persisted plan SECTION removed and every audit note KEPT —
 * what a task file must become when its plan is discarded rather than merely
 * hidden from a prompt. Pure; identity for a body carrying no plan.
 *
 * The distinction from `stripPlanAndAuditTail` is the whole reason this exists,
 * and it is not stylistic: that one renders a prompt, so it drops the audit tail
 * too and may slice from the first heading to the end. This one is PERSISTED, so
 * the audit trail — the only record a human has of what the loop did — has to
 * survive intact. `appendPlan` appends at end of file, so a replanned task
 * INTERLEAVES plans and notes (`plan → Plan written → Plan rejected → plan …`);
 * cutting one span from the first heading onward would delete the notes between
 * them. Hence the per-section walk: each `## Implementation Plan` run ends at the
 * next audit-note line (`auditTailIndex`), which is exactly the boundary
 * `extractPlan` reads a plan up to, so writer and reader agree on what a section
 * is.
 *
 * The surviving spans are re-joined on exactly one blank line, so a task
 * re-shaped twice does not accrete vertical whitespace at the seams. Only the
 * seams are touched — blank lines INSIDE a surviving span are the human's prose
 * and are left alone.
 */
export const withoutPlanSections = (body: string): string => {
  if (firstMarkerIndex(body, PLAN_HEADING) === -1) return body
  const spans: string[] = []
  let idx = 0
  for (;;) {
    const rel = firstMarkerIndex(body.slice(idx), PLAN_HEADING)
    if (rel === -1) {
      spans.push(body.slice(idx))
      break
    }
    const start = idx + rel
    spans.push(body.slice(idx, start))
    idx = auditTailIndex(body, start)
    if (idx >= body.length) break
  }
  const kept = spans.map((s) => s.replace(/^\n+/, "").trimEnd()).filter((s) => s.length > 0)
  return kept.length > 0 ? `${kept.join("\n\n")}\n` : ""
}
