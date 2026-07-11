import type { StageTokens } from "@agentic-loop/core/loop/metrics"
import type { RunLogSummary } from "@agentic-loop/core/loop/runlog"
import type { MetricsSample } from "@agentic-loop/core/loop/metrics-file"

/**
 * Time-window token attribution — pure. When a host can't observe usage
 * directly (the Claude host), token records from its transcripts are summed
 * into whichever stage window they fall in. Attribution by overlap is
 * explicitly an estimate; callers flag it.
 */

export interface StageWindow {
  readonly stage: string
  readonly lens?: string
  /** 1-based for display. */
  readonly iteration: number
  /** Epoch ms, inclusive. */
  readonly startMs: number
  /** Epoch ms, exclusive. */
  readonly endMs: number
}

export interface UsageRecord {
  /** Epoch ms of the assistant message. */
  readonly atMs: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly model?: string
}

export const ZERO_TOKENS: StageTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export const addTokens = (a: StageTokens, b: StageTokens): StageTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** Windows from sidecar samples that carry `startedAt` (both hosts record it now). Pure. */
export const windowsFromSamples = (samples: readonly MetricsSample[]): StageWindow[] =>
  samples.flatMap((s) => {
    if (!s.startedAt) return []
    const start = Date.parse(s.startedAt)
    if (Number.isNaN(start)) return []
    return [
      {
        stage: s.stage,
        ...(s.lens ? { lens: s.lens } : {}),
        iteration: s.iteration + 1,
        startMs: start,
        endMs: start + s.ms,
      },
    ]
  })

/**
 * Windows reconstructed from a legacy run-log summary (no sidecar): stages ran
 * sequentially and the summary stamp is the run's end, so walk the rows'
 * durations backwards from it. Coarse — sums include inter-stage overhead —
 * but it is what pre-instrumentation logs give us. Pure.
 */
export const windowsFromSummary = (summary: RunLogSummary): StageWindow[] => {
  const end = Date.parse(summary.at)
  if (Number.isNaN(end)) return []
  const totalMs = summary.rows.reduce((sum, r) => sum + r.seconds * 1000, 0)
  let cursor = end - totalMs
  return summary.rows.map((r) => {
    const startMs = cursor
    cursor += r.seconds * 1000
    return {
      stage: r.stage,
      ...(r.lens ? { lens: r.lens } : {}),
      iteration: r.iteration,
      startMs,
      endMs: cursor,
    }
  })
}

/** Sum the usage records falling inside each window. Windows with no hits are dropped. Pure. */
export const attribute = (
  windows: readonly StageWindow[],
  records: readonly UsageRecord[],
): { window: StageWindow; tokens: StageTokens; model?: string }[] =>
  windows.flatMap((window) => {
    const hits = records.filter((r) => r.atMs >= window.startMs && r.atMs < window.endMs)
    if (hits.length === 0) return []
    const tokens = hits.reduce(
      (acc, r) => addTokens(acc, { input: r.input, output: r.output, reasoning: 0, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }),
      ZERO_TOKENS,
    )
    const model = hits.find((r) => r.model)?.model
    return [{ window, tokens, ...(model ? { model } : {}) }]
  })
