import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { RunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import type { RunMetricsInput } from "./aggregate.js"

/**
 * Run-log fixtures for the metrics tests, built as MARKDOWN and pushed through
 * the real `parseRunLog` rather than hand-authored `ParsedRunLog` literals. The
 * aggregation's sharp edges are all things the parser does to a log — a `—`
 * verdict becoming `undefined`, a `—` wall-clock parsing to 0 seconds, a
 * footer-less summary yielding no `cap` — so a hand-built literal would test the
 * aggregator against a shape the parser never actually produces.
 *
 * Test-only, but not a `.test.ts` file: the node --test glob would run it as an
 * empty suite.
 */

/** One `| # | stage | iter | verdict | wall-clock |` row. Pass `"—"` for an absent cell. */
export const row = (n: number, stage: string, iter: number, verdict: string, wall: string): string =>
  `| ${n} | ${stage} | ${iter} | ${verdict} | ${wall} |`

/**
 * One terminal summary block. `footer` omitted reproduces an older log that
 * recorded no `iterations used: N/M` line — the case that must not become a
 * burn ratio of 0.
 */
export const summary = (
  outcome: string,
  rows: readonly string[],
  footer?: { readonly used: number; readonly cap: number },
): string =>
  [
    "",
    `## run · ${outcome}`,
    "",
    `## Run summary · ${outcome} · 2026-07-05T13:16:25.138Z`,
    "",
    "| # | stage | iter | verdict | wall-clock |",
    "|---|-------|------|---------|------------|",
    ...rows,
    "",
    ...(footer ? [`iterations used: ${footer.used}/${footer.cap} · total: 36s · outcome: ${outcome}`] : []),
    "",
  ].join("\n")

/** A run's parsed evidence, as the route would hand it to `aggregateMetrics`. */
export const runInput = (id: string, markdown: string, sidecar: RunMetrics | null = null): RunMetricsInput => ({
  id,
  log: parseRunLog(markdown),
  sidecar,
})
