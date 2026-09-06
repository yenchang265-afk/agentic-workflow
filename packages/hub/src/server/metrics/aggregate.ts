import {
  firstPassYield,
  iterationBurn,
  metricsHeadline,
  outcomeTally,
  passKind,
  rate,
  stageDurations,
  windowInputs,
  type MetricsWindow,
  type RunMetricsInput,
} from "@agentic-workflow/core/workflow/metrics-aggregate"
import type { DiscoveryStats, MetricsResponse, PlanQualityStats } from "../../shared/api.js"
import { PARK_NO_PLAN_WHY, PARK_NO_VERIFICATION_WHY } from "@agentic-workflow/core/workflow/terminal"
import { cacheHit, countInProgress } from "./cache.js"
import { fanoutStats } from "./fanout.js"
import { findingsStats } from "./findings.js"
import { modelStats } from "./models.js"
import { promptSize } from "./prompt.js"
import { toolStats } from "./tools.js"
import { stageVerdicts, verdictFlips } from "./verdicts.js"

/**
 * Roll every run's on-disk evidence up into the cross-run view. Pure — the
 * route does the reading and parsing, this does the arithmetic.
 *
 * The unit of analysis is the **pass** (one terminal `RunLogSummary`), not the
 * file. A `runs/<id>.md` accumulates a plan pass and then a build pass:
 * independent runs with their own cap, iteration count and verdict stream.
 * Averaging them into one file-level number is meaningless, and keeping only
 * the latest (as the run list does for display) discards half the evidence. So
 * the response carries `runsTotal` and `passesTotal` both, and every rate names
 * the population it actually measured.
 */

export type { RunMetricsInput }

export const aggregateMetrics = (
  allInputs: readonly RunMetricsInput[],
  skippedRuns: readonly string[],
  window: MetricsWindow & { readonly days?: number | null } = {},
): MetricsResponse => {
  // The window narrows the population BEFORE anything is counted (design 64),
  // so every rate below measures the same slice and `runsTotal` says how big
  // that slice is. `kinds` comes from the unwindowed population: it is the
  // filter's choice list, and a filtered response must still offer the rest.
  const inputs = windowInputs(allInputs, window)
  const passes = inputs.flatMap((input) => input.log.summaries)
  const headline = metricsHeadline(allInputs, window)

  return {
    runsTotal: inputs.length,
    runsWithSummary: inputs.filter((input) => input.log.summaries.length > 0).length,
    passesTotal: passes.length,
    runsInProgress: countInProgress(inputs),
    outcomes: outcomeTally(passes),
    burn: iterationBurn(passes),
    firstPass: firstPassYield(passes),
    verdicts: stageVerdicts(passes),
    flips: verdictFlips(passes),
    durations: stageDurations(passes),
    cache: cacheHit(inputs),
    prompt: promptSize(inputs),
    fanout: fanoutStats(inputs),
    models: modelStats(inputs),
    tools: toolStats(inputs),
    ...stoppedSplit(inputs),
    findings: findingsStats(inputs),
    plans: planStats(inputs),
    discovery: discoveryStats(inputs),
    skippedRuns,
    trend: headline.trend,
    window: { days: window.days ?? null, kind: window.kind ?? null },
    kinds: [...new Set(allInputs.flatMap((i) => i.log.summaries.map(passKind)))].sort(),
  }
}

/**
 * Plan-quality signals from the sidecars. A `runs/<id>` file accumulates one
 * entry per pass, so a rejected-then-replanned task shows as ≥2 entries with
 * plan-stage samples in one file; a contract refusal is an `error` entry whose
 * detail is the park gate's own refusal string (imported, not copied — see
 * `PARK_NO_PLAN_WHY`). `capTripRate` stays the cap-side proxy; these are the
 * plan gate's own numbers.
 */
const planStats = (inputs: readonly RunMetricsInput[]): PlanQualityStats => {
  let runsWithPlanPass = 0
  let replannedRuns = 0
  let contractRefusals = 0
  for (const input of inputs) {
    const entries = input.sidecar?.runs ?? []
    const planEntries = entries.filter((entry) => entry.samples.some((s) => s.stage === "plan")).length
    if (planEntries > 0) runsWithPlanPass++
    if (planEntries > 1) replannedRuns++
    for (const entry of entries) {
      if (entry.outcome !== "error" || !entry.detail) continue
      if (entry.detail.startsWith(PARK_NO_PLAN_WHY) || entry.detail.startsWith(PARK_NO_VERIFICATION_WHY)) contractRefusals++
    }
  }
  return { runsWithPlanPass, replannedRuns, replanRate: rate(replannedRuns, runsWithPlanPass), contractRefusals }
}

/**
 * Check-command provenance across check-stage FIRINGS. A firing is one
 * (entry × stage × iteration): under fan-out the OpenCode host stamps every
 * pass's sample with the same provenance, so the first sample of each group
 * wins and a lens fan-out is not counted N times.
 */
const discoveryStats = (inputs: readonly RunMetricsInput[]): DiscoveryStats => {
  let checkStageFirings = 0
  const bySource: Record<string, number> = {}
  const byStage: Record<string, Record<string, number>> = {}
  let refusedTotal = 0
  for (const input of inputs) {
    for (const [entryIdx, entry] of (input.sidecar?.runs ?? []).entries()) {
      const seen = new Set<string>()
      for (const sample of entry.samples) {
        if (sample.checksSource === undefined) continue
        const key = `${entryIdx}:${sample.stage}:${sample.iteration}`
        if (seen.has(key)) continue
        seen.add(key)
        checkStageFirings++
        bySource[sample.checksSource] = (bySource[sample.checksSource] ?? 0) + 1
        const stageTally = (byStage[sample.stage] ??= {})
        stageTally[sample.checksSource] = (stageTally[sample.checksSource] ?? 0) + 1
        refusedTotal += sample.checksRefused ?? 0
      }
    }
  }
  return { checkStageFirings, bySource, byStage, refusedTotal }
}

/**
 * Sidecar-recorded stops split by the retryable flag. Sidecar population only:
 * the run log's footer never carried the distinction, so the log-derived
 * `outcomes` tally stays untouched.
 */
const stoppedSplit = (inputs: readonly RunMetricsInput[]): { stoppedRetryable: number; stoppedFinal: number } => {
  let stoppedRetryable = 0
  let stoppedFinal = 0
  for (const input of inputs) {
    for (const entry of input.sidecar?.runs ?? []) {
      if (entry.outcome !== "stopped") continue
      if (entry.retryable) stoppedRetryable++
      else stoppedFinal++
    }
  }
  return { stoppedRetryable, stoppedFinal }
}
