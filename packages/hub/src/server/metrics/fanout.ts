import type { FanoutStats, StageFanout } from "../../shared/api.js"
import type { RunMetricsInput } from "./aggregate.js"
import { stageLabel } from "./stage-label.js"

/**
 * Fan-out accounting for focused (lens/axis) check stages. Pure.
 *
 * Turning a `stageFanout` on — per-axis or a lens list — multiplies both cost and
 * artifact size with no signal in the run summary that it did — this is that
 * signal. One "arming" is a single firing of the stage: the samples of one run
 * entry sharing a stage and iteration. Its pass count is the number of
 * DISTINCT lens labels, so a verdict retry (a second sample for the same
 * focus) does not read as a wider fan-out; its context bill is the SUM of all
 * its samples' `promptChars` — retries included, because each retry sent the
 * whole composed prompt again.
 *
 * Only armings that ran at least one focused pass are counted: a single-pass
 * stage has no fan-out to report, and folding it in as "1 pass" would dilute
 * the multiplier this exists to surface.
 */

interface Arming {
  stage: string
  focuses: Set<string>
  sizedChars: number
  sized: boolean
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length)

export const fanoutStats = (inputs: readonly RunMetricsInput[]): FanoutStats => {
  const armings = new Map<string, Arming>()

  let entryOrdinal = 0
  for (const input of inputs) {
    for (const run of input.sidecar?.runs ?? []) {
      entryOrdinal++
      for (const sample of run.samples) {
        if (sample.lens === undefined) continue
        const stage = stageLabel(run.kind, sample.stage)
        const key = `${input.id}\u0000${entryOrdinal}\u0000${stage}\u0000${sample.iteration}`
        const a = armings.get(key) ?? { stage, focuses: new Set<string>(), sizedChars: 0, sized: false }
        armings.set(key, {
          stage,
          focuses: new Set([...a.focuses, sample.lens]),
          sizedChars: a.sizedChars + (sample.promptChars ?? 0),
          sized: a.sized || sample.promptChars !== undefined,
        })
      }
    }
  }

  const byStage = new Map<string, Arming[]>()
  for (const arming of armings.values()) {
    byStage.set(arming.stage, [...(byStage.get(arming.stage) ?? []), arming])
  }

  const stages: StageFanout[] = [...byStage.entries()]
    .map(([stage, list]) => {
      const passes = list.map((a) => a.focuses.size)
      const sized = list.filter((a) => a.sized)
      return {
        stage,
        armings: list.length,
        meanPasses: mean(passes),
        maxPasses: passes.reduce((m, p) => (p > m ? p : m), 0),
        meanArmingPromptChars: sized.length === 0 ? null : mean(sized.map((a) => a.sizedChars)),
      }
    })
    .sort((a, b) => b.meanPasses * b.armings - a.meanPasses * a.armings)

  return { stages }
}
