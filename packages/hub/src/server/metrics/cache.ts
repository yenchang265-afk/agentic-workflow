import type { CacheHit, StageCache } from "../../shared/api.js"
import type { RunMetricsInput } from "./aggregate.js"

/**
 * Prompt-cache effectiveness from the `runs/<id>.metrics.json` sidecars. Pure.
 *
 * Sidecars only — never the transcript-attribution path in `tokens/resolve.ts`.
 * That path assigns usage to stages by time-window overlap with a minute of
 * slack, so a ratio built from it divides one estimate by another with
 * correlated error: it would look like the same metric as this one, disagree
 * with it, and offer no principled reconciliation. `runsCovered` reports the
 * honest denominator instead — only the opencode driver observes tokens, so
 * this describes a slice of the fleet, not all of it.
 */

interface Sums {
  samples: number
  input: number
  cacheRead: number
}

const zero = (): Sums => ({ samples: 0, input: 0, cacheRead: 0 })

/** `cacheRead / (input + cacheRead)`, or null when nothing was observed. Pure. */
const ratioOf = (s: Sums): number | null => {
  const total = s.input + s.cacheRead
  return total === 0 ? null : s.cacheRead / total
}

/**
 * Token-weighted cache-hit ratio, overall and per stage.
 *
 * Weighted by tokens rather than averaged over stages: a mean of per-stage
 * ratios gives a stage that read ten tokens the same say as one that read a
 * million, which inverts the number whenever a cheap stage misses the cache.
 *
 * `open` entries are included. `upsertRunMetrics` replaces a trailing open entry
 * rather than appending, so an open entry is never a duplicate of a finalized
 * one, and excluding it would silently drop live runs' observations.
 */
export const cacheHit = (inputs: readonly RunMetricsInput[]): CacheHit => {
  const overall = zero()
  const byStage = new Map<string, Sums>()
  let runsCovered = 0

  for (const input of inputs) {
    if (!input.sidecar) continue
    let observedHere = false
    for (const run of input.sidecar.runs) {
      for (const sample of run.samples) {
        if (!sample.tokens) continue
        observedHere = true
        overall.samples++
        overall.input += sample.tokens.input
        overall.cacheRead += sample.tokens.cacheRead
        const stage = byStage.get(sample.stage) ?? zero()
        byStage.set(sample.stage, {
          samples: stage.samples + 1,
          input: stage.input + sample.tokens.input,
          cacheRead: stage.cacheRead + sample.tokens.cacheRead,
        })
      }
    }
    if (observedHere) runsCovered++
  }

  const stages: StageCache[] = [...byStage.entries()]
    .map(([stage, s]) => ({ stage, samples: s.samples, input: s.input, cacheRead: s.cacheRead, ratio: ratioOf(s) }))
    .sort((a, b) => b.input + b.cacheRead - (a.input + a.cacheRead))

  return {
    runsCovered,
    samples: overall.samples,
    input: overall.input,
    cacheRead: overall.cacheRead,
    ratio: ratioOf(overall),
    stages,
  }
}

/**
 * Runs still accruing — a sidecar whose trailing entry is `open`. Reported
 * separately because such a run has written no terminal summary yet and so is
 * absent from every pass-scoped metric; without this counter that omission is
 * invisible. Pure.
 */
export const countInProgress = (inputs: readonly RunMetricsInput[]): number =>
  inputs.filter((input) => input.sidecar?.runs[input.sidecar.runs.length - 1]?.open === true).length
