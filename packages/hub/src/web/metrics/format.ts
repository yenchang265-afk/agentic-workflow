import type { BurnBucket } from "../../shared/api.js"

/**
 * Presentation helpers for the metrics tab. Pure, and deliberately in a plain
 * `.ts` module rather than inside the components: there is no component test
 * harness in this package, so anything with a decidable right answer has to
 * live where `node --test` can reach it.
 */

/**
 * A rate as a percentage, or an em dash when it was unmeasurable.
 *
 * The whole point of the `number | null` rates on the wire is that "no runs
 * recorded a cap" and "no run ever tripped the cap" are different findings.
 * Rendering null as `0%` would throw that away at the last step.
 */
export const pct = (value: number | null, digits = 0): string =>
  value === null ? "—" : `${(value * 100).toFixed(digits)}%`

/** A burn bucket's axis label: `0–25%`, or `100%` for the closed capped bucket. */
export const bucketLabel = (bucket: BurnBucket): string =>
  bucket.from === bucket.to ? `${bucket.from * 100}%` : `${bucket.from * 100}–${bucket.to * 100}%`

/**
 * Bar length in px. A non-zero count always gets at least one pixel, so a
 * bucket holding a single run stays visible next to one holding a hundred.
 */
export const barWidth = (count: number, max: number, width: number): number =>
  max <= 0 || count <= 0 ? 0 : Math.max(1, (count / max) * width)

/**
 * A character count, abbreviated. Prompt sizes run to tens of thousands, where
 * the exact digit is noise and the magnitude is the finding. Rounded to one
 * decimal at `k` so 8.2k and 24.0k stay distinguishable at a glance.
 */
export const formatChars = (chars: number): string => {
  const n = Math.round(chars)
  return n < 1_000 ? String(n) : `${(n / 1_000).toFixed(1)}k`
}

/** A token count, abbreviated the way `TokenPanel` renders them (1.2k / 3.4M). */
export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/**
 * "Ns ago" / "Nm ago" / "Nh Mm ago" for a timestamp, against a caller-supplied
 * now (components tick it; tests pin it). An unparseable timestamp renders
 * verbatim rather than as NaN.
 */
export const timeAgo = (iso: string, nowMs: number): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}
