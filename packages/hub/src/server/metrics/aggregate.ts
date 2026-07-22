import type { ParsedRunLog, RunLogSummary, RunSummaryRow } from "@agentic-workflow/core/workflow/runlog"
import type { RunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import type {
  BurnBucket,
  FirstPassYield,
  IterationBurn,
  MetricsResponse,
  StageDuration,
} from "../../shared/api.js"
import { cacheHit, countInProgress } from "./cache.js"
import { isCheckRow, stageVerdicts, verdictFlips } from "./verdicts.js"

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

/** One run's on-disk evidence, already read and parsed by the route. */
export interface RunMetricsInput {
  readonly id: string
  readonly log: ParsedRunLog
  /** Parsed `<id>.metrics.json`; null when absent or schema-invalid. */
  readonly sidecar: RunMetrics | null
}

const BUCKET_EDGES = [0, 0.25, 0.5, 0.75] as const

const mean = (xs: readonly number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

/**
 * Iteration burn as a RATIO of the pass's own cap, so runs under different caps
 * stay comparable. A pass whose footer recorded no `iterations used: N/M` is
 * counted in `passesUnmeasured` and touches nothing else — folding it in as
 * ratio 0 would read as a perfectly converging run.
 */
const iterationBurn = (passes: readonly RunLogSummary[]): IterationBurn => {
  const ratios: number[] = []
  let cappedPasses = 0
  let passesUnmeasured = 0

  for (const pass of passes) {
    if (pass.iterationsUsed === undefined || pass.cap === undefined || pass.cap <= 0) {
      passesUnmeasured++
      continue
    }
    ratios.push(pass.iterationsUsed / pass.cap)
    // `>=` not `===`: a cap lowered in config mid-run can leave a pass above it.
    if (pass.iterationsUsed >= pass.cap) cappedPasses++
  }

  const buckets: BurnBucket[] = [
    ...BUCKET_EDGES.map((from) => ({ from, to: from + 0.25, passes: 0 })),
    { from: 1, to: 1, passes: 0 },
  ]
  for (const ratio of ratios) {
    const index = ratio >= 1 ? buckets.length - 1 : Math.min(BUCKET_EDGES.length - 1, Math.floor(ratio / 0.25))
    const bucket = buckets[index]
    if (bucket) buckets[index] = { ...bucket, passes: bucket.passes + 1 }
  }

  return {
    passesMeasured: ratios.length,
    passesUnmeasured,
    meanRatio: ratios.length === 0 ? null : mean(ratios),
    medianRatio: ratios.length === 0 ? null : median(ratios),
    cappedPasses,
    capTripRate: rate(cappedPasses, ratios.length),
    buckets,
  }
}

/**
 * Share of passes that got every check right the first time.
 *
 * Deliberately derived from the check rows rather than `iterationsUsed`, so it
 * stays measurable on older footer-less logs. `<= 1` rather than `=== 1`
 * because a log missing its `iter` column parses to iteration 0 — a degenerate
 * single-iteration pass, not a retry.
 */
const firstPassYield = (passes: readonly RunLogSummary[]): FirstPassYield => {
  let passesMeasured = 0
  let passesWithoutChecks = 0
  let cleanPasses = 0

  for (const pass of passes) {
    const checks = pass.rows.filter(isCheckRow)
    if (checks.length === 0) {
      passesWithoutChecks++
      continue
    }
    passesMeasured++
    const highest = checks.reduce((max, row) => Math.max(max, row.iteration), 0)
    if (highest <= 1 && checks.every((row) => row.verdict === "PASS")) cleanPasses++
  }

  return { passesMeasured, passesWithoutChecks, cleanPasses, rate: rate(cleanPasses, passesMeasured) }
}

/**
 * A row carries a duration only if its wall-clock cell names a unit.
 *
 * `parseDuration` returns 0 for anything it cannot read — including the `—`
 * that marks an absent cell — so summing raw `seconds` would quietly pull every
 * stage mean toward zero and read as a speed-up.
 */
const hasDuration = (row: RunSummaryRow): boolean => /\d+\s*[hms]/.test(row.duration)

const stageDurations = (passes: readonly RunLogSummary[]): StageDuration[] => {
  const byStage = new Map<string, number[]>()
  for (const pass of passes) {
    for (const row of pass.rows) {
      if (!hasDuration(row)) continue
      byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row.seconds])
    }
  }
  return [...byStage.entries()]
    .map(([stage, seconds]) => ({
      stage,
      rows: seconds.length,
      meanSeconds: mean(seconds),
      medianSeconds: median(seconds),
      maxSeconds: Math.max(...seconds),
    }))
    .sort((a, b) => b.meanSeconds * b.rows - a.meanSeconds * a.rows)
}

/**
 * Outcome tallies keyed by the log's own word rather than a fixed
 * done/stopped/error triple — the summary header matches any lowercase word, so
 * a newer outcome should surface here instead of vanishing into an `else`.
 */
const outcomeTally = (passes: readonly RunLogSummary[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const pass of passes) counts[pass.outcome] = (counts[pass.outcome] ?? 0) + 1
  return counts
}

export const aggregateMetrics = (
  inputs: readonly RunMetricsInput[],
  skippedRuns: readonly string[],
): MetricsResponse => {
  const passes = inputs.flatMap((input) => input.log.summaries)

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
    skippedRuns,
  }
}
