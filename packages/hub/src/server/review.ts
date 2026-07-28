import type { ParsedRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { AuditNote, ReviewItem, ReviewRunContext } from "../shared/api.js"

/**
 * The pure derivations behind the review queue.
 *
 * A gate decision needs to know how long a task has waited, what the loop last
 * did to it, and roughly what the plan says. None of that was on the wire, and
 * two of the three needed no new storage at all — they were already sitting in
 * the task body and the run log, unread.
 *
 * Everything here is pure so `node --test` can reach it; the route does the IO.
 */

/**
 * Timestamps derived from the audit trail.
 *
 * Core's `Task` has no timestamps and its frontmatter schema defines none, so
 * there is nothing to read directly. But the loop stamps every audit note
 * (`> <event> [<ISO> by <actor>]`) and `extractAuditNotes` already parses them
 * out of a body the backlog listing has in hand — so this costs no extra IO.
 *
 * Notes without a stamp contribute nothing rather than defaulting to now: a
 * task whose trail was never stamped has an UNKNOWN age, and rendering that as
 * "0 minutes" would invent a fact. Null all the way to the UI.
 */
export const noteTimestamps = (
  notes: readonly AuditNote[],
): { createdAt: string | null; lastEventAt: string | null; lastEvent: string | null } => {
  const stamped = notes.filter((n) => n.at !== "")
  const first = stamped[0]
  const last = stamped[stamped.length - 1]
  return {
    createdAt: first?.at ?? null,
    lastEventAt: last?.at ?? null,
    // The event text comes from the same note as the timestamp, so they can
    // never describe different moments.
    lastEvent: last?.event ?? null,
  }
}

/** Opening of a plan, whitespace-collapsed, cut on a word boundary when possible. */
export const planExcerpt = (plan: string | undefined, max = 400): string | null => {
  if (plan === undefined) return null
  const flat = plan.replace(/\s+/g, " ").trim()
  if (flat === "") return null
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * What the newest pass in a run log says.
 *
 * `failedStage` is the last row whose verdict is neither PASS nor absent —
 * "which stage went wrong", the single most useful thing a replan decision
 * needs and the thing the board never showed. A run whose rows all passed has
 * none, which is different from having no rows at all; both render as null and
 * the UI says which by also carrying `lastVerdict`.
 */
export const runContext = (id: string, log: ParsedRunLog): ReviewRunContext | null => {
  const latest = log.summaries[log.summaries.length - 1]
  if (!latest) return null
  const failed = [...latest.rows].reverse().find((r) => r.verdict !== undefined && r.verdict !== "PASS")
  const lastRow = latest.rows[latest.rows.length - 1]
  return {
    id,
    outcome: latest.outcome,
    at: latest.at,
    iterationsUsed: latest.iterationsUsed ?? null,
    cap: latest.cap ?? null,
    failedStage: failed?.stage ?? null,
    lastVerdict: lastRow?.verdict ?? null,
  }
}

/**
 * Longest-waiting first — the order in which a human should work the queue.
 *
 * Items with no known age sort last rather than first: an unknown age is not
 * evidence of urgency, and putting them on top would let untimestamped tasks
 * permanently outrank real ones. Ties break on id so the order is stable
 * across refetches (a queue that reshuffles under the cursor is its own bug).
 */
export const byWaiting = (a: ReviewItem, b: ReviewItem): number => {
  const at = a.lastEventAt
  const bt = b.lastEventAt
  if (at === null && bt === null) return a.card.id.localeCompare(b.card.id)
  if (at === null) return 1
  if (bt === null) return -1
  return at === bt ? a.card.id.localeCompare(b.card.id) : at.localeCompare(bt)
}
