/**
 * Render a list of filesystem-derived task ids for injection into a model's
 * context, bounded and sanitized.
 *
 * `reconcile` runs at SessionStart and joins directory listings — `runs/`, and
 * `queued/.claims/` with no filter at all — straight into `additionalContext`.
 * Those names are file names, which is to say they are whatever was on disk: a
 * cloned repo can ship `queued/.claims/` entries whose names embed newlines
 * (legal on Linux), and that text then lands in every session's context before
 * the user types anything. Even with nobody being clever, a backlog with
 * hundreds of stale snapshots dumped every id into every session.
 *
 * So names that don't look like task ids are dropped and the rest are capped —
 * and both facts are stated in the output rather than silently applied, because
 * a truncated list that reads as complete is its own kind of wrong.
 */

/** What a task id may look like on disk. Anything else is not rendered. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

/** Most ids to name before summarizing the rest. */
export const MAX_LISTED = 20

/**
 * `names` as a human-readable clause, or "" when nothing survives sanitizing.
 * Dropped and truncated entries are counted in the text.
 */
export const idList = (names, max = MAX_LISTED) => {
  const safe = []
  let unprintable = 0
  for (const n of names) {
    if (SAFE_ID.test(n)) safe.push(n)
    else unprintable += 1
  }
  const shown = safe.slice(0, max)
  const parts = []
  if (shown.length) parts.push(shown.join(", "))
  const hidden = safe.length - shown.length
  if (hidden > 0) parts.push(`+${hidden} more`)
  if (unprintable > 0) parts.push(`${unprintable} with unusable name(s) not shown`)
  return parts.join("; ")
}
