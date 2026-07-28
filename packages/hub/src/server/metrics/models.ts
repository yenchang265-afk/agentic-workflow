import type { ModelStats, StageModelStats } from "../../shared/api.js"
import type { RunMetricsInput } from "./aggregate.js"
import { stageLabel } from "./stage-label.js"

/**
 * Which model ran which stage, and what it cost — the sidecar's `model`/`cost`
 * fields aggregated for the first time. Sidecar-only by construction (the
 * transcript fallback never carries a per-stage model), so `runsCovered` reads
 * against `runsTotal` the same way `cache.runsCovered` does: this describes the
 * opencode-driven slice of the fleet.
 *
 * Samples without a `model` go to `samplesWithoutModel` and touch no row —
 * folding them into a pseudo-model bucket would let "unrecorded" masquerade as
 * a real binding.
 */

interface Acc {
  samples: number
  costSamples: number
  totalCost: number
  totalMs: number
  totalIteration: number
}

export const modelStats = (inputs: readonly RunMetricsInput[]): ModelStats => {
  const byKey = new Map<string, Acc>()
  let samplesWithoutModel = 0
  let runsCovered = 0

  for (const input of inputs) {
    if (!input.sidecar) continue
    let covered = false
    for (const entry of input.sidecar.runs) {
      for (const sample of entry.samples) {
        if (!sample.model) {
          samplesWithoutModel++
          continue
        }
        covered = true
        // NUL-joined key: neither a stage nor a model name can contain it.
        const key = `${stageLabel(entry.kind, sample.stage)}\u0000${sample.model}`
        const acc = byKey.get(key) ?? { samples: 0, costSamples: 0, totalCost: 0, totalMs: 0, totalIteration: 0 }
        acc.samples++
        acc.totalMs += sample.ms
        // Sidecar iterations are 0-based; report the 1-based mean the run log shows.
        acc.totalIteration += sample.iteration + 1
        if (sample.cost !== undefined) {
          acc.costSamples++
          acc.totalCost += sample.cost
        }
        byKey.set(key, acc)
      }
    }
    if (covered) runsCovered++
  }

  const rows: StageModelStats[] = [...byKey.entries()]
    .map(([key, acc]) => {
      const [stage = "", model = ""] = key.split("\u0000")
      return {
        stage,
        model,
        samples: acc.samples,
        costSamples: acc.costSamples,
        totalCost: acc.totalCost,
        meanMs: acc.totalMs / acc.samples,
        meanIteration: acc.totalIteration / acc.samples,
      }
    })
    .sort((a, b) => b.totalCost - a.totalCost || b.samples - a.samples || a.stage.localeCompare(b.stage))

  return { runsCovered, samplesWithoutModel, rows }
}
