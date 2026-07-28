/**
 * How long something has been waiting, as a compact label.
 *
 * Pure and given `now` explicitly rather than reading the clock, so it is
 * testable in a package with no DOM harness — and so a list of ages can be
 * rendered against ONE instant instead of drifting between rows.
 *
 * Returns null for an unknown time, never "0m". A task whose audit trail was
 * never stamped has no recorded age, and the queue says "age unknown" rather
 * than claiming it just arrived — which would sort and read as the freshest
 * item on the board when it may be the oldest.
 */
export const ageLabel = (iso: string | null, now: number): string | null => {
  if (iso === null) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null

  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/** Iteration burn as `3/8`, or null when the pass recorded no cap. */
export const burnLabel = (used: number | null, cap: number | null): string | null =>
  used === null || cap === null ? null : `${used}/${cap}`

/** Whether a pass spent its whole allowance — the loop stopped rather than converged. */
export const isCapTripped = (used: number | null, cap: number | null): boolean =>
  used !== null && cap !== null && cap > 0 && used >= cap
