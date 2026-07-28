import type { PromptSize, StagePromptSize } from "../../shared/api.js"
import type { RunMetricsInput } from "./aggregate.js"
import { stageLabel } from "./stage-label.js"

/**
 * Composed-prompt size per stage, from the `runs/<id>.metrics.json` sidecars. Pure.
 *
 * Deliberately NOT folded into `cacheHit`. That loop skips any sample without a
 * `tokens` block, and only the opencode driver observes tokens — so it is blind to
 * every Claude-host run, which is exactly the host where `promptChars` is the only
 * size signal available. This gate is `promptChars !== undefined` instead, so the
 * panel covers both hosts.
 *
 * What it is for: the prompt grows monotonically across a struggling run's
 * iterations (each stage's transcript threads into the next), so growth here is
 * the signal that a context budget is needed — and `elidedSamples` is how you
 * tell "the budget is biting" from "the prompt is small".
 */

interface Sums {
  chars: number[]
  elidedSamples: number
  elidedChars: number
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length)

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export const promptSize = (inputs: readonly RunMetricsInput[]): PromptSize => {
  const byStage = new Map<string, Sums>()
  let runsCovered = 0
  let samples = 0

  for (const input of inputs) {
    if (!input.sidecar) continue
    let observedHere = false
    for (const run of input.sidecar.runs) {
      for (const sample of run.samples) {
        if (sample.promptChars === undefined) continue
        observedHere = true
        samples++
        const label = stageLabel(run.kind, sample.stage)
        const s = byStage.get(label) ?? { chars: [], elidedSamples: 0, elidedChars: 0 }
        const elided = sample.promptElided ?? 0
        byStage.set(label, {
          chars: [...s.chars, sample.promptChars],
          elidedSamples: s.elidedSamples + (elided > 0 ? 1 : 0),
          elidedChars: s.elidedChars + elided,
        })
      }
    }
    if (observedHere) runsCovered++
  }

  const stages: StagePromptSize[] = [...byStage.entries()]
    .map(([stage, s]) => ({
      stage,
      samples: s.chars.length,
      meanChars: mean(s.chars),
      medianChars: median(s.chars),
      // reduce, not Math.max(...xs): a spread call-stacks on huge arrays, and
      // reduce stays 0 (not -Infinity) if the bucket is ever empty.
      maxChars: s.chars.reduce((m, c) => (c > m ? c : m), 0),
      elidedSamples: s.elidedSamples,
      elidedChars: s.elidedChars,
    }))
    .sort((a, b) => b.maxChars - a.maxChars)

  return { runsCovered, samples, stages }
}
