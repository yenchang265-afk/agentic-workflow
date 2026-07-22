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
