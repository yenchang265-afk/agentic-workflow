import type { Stage } from "./state.ts"
import type { Verdict } from "./verdict.ts"

/**
 * Per-run stage metrics — wall-clock and verdict history — rendered into the
 * run log on a terminal event so "is the loop converging or burning
 * iterations?" is answerable weeks later. The accumulator lives in the driver
 * (keyed by session, in-memory); the rendering here is **pure**. See
 * docs/design/improvements/06.
 */

export interface StageSample {
  readonly stage: Stage
  readonly iteration: number
  readonly ms: number
  /** Present for check stages (verify/review) only. */
  readonly verdict?: Verdict | "none"
  /** The review lens, when this sample is one lens pass of a multi-lens review. */
  readonly lens?: string
}

export type Outcome = "done" | "stopped" | "error"

/** Format a millisecond duration as `2m 41s` / `45s` / `1h 03m`. Pure. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/**
 * Render a `## Run summary` markdown block from the collected samples. Pure —
 * the caller stamps the timestamp and appends via `appendRunLog`.
 */
export const renderRunSummary = (
  samples: readonly StageSample[],
  outcome: Outcome,
  detail: string,
  maxIterations: number,
  stampISO: string,
): string => {
  const iterationsUsed = samples.reduce((max, s) => Math.max(max, s.iteration + 1), 0)
  const totalMs = samples.reduce((sum, s) => sum + s.ms, 0)
  const header = `## Run summary · ${outcome}${detail ? `: ${detail}` : ""} · ${stampISO}`
  const rows = samples
    .map((s, i) => {
      const stage = s.lens ? `${s.stage} (${s.lens})` : s.stage
      const verdict = s.verdict ?? "—"
      return `| ${i + 1} | ${stage} | ${s.iteration + 1} | ${verdict} | ${formatDuration(s.ms)} |`
    })
    .join("\n")
  const table = samples.length
    ? `| # | stage | iter | verdict | wall-clock |\n|---|-------|------|---------|------------|\n${rows}`
    : "_(no stages ran)_"
  const footer = `iterations used: ${iterationsUsed}/${maxIterations} · total: ${formatDuration(totalMs)} · outcome: ${outcome}`
  return `${header}\n\n${table}\n\n${footer}`
}
