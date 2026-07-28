import type { ToolStats } from "../../shared/api.js"
import type { RunMetricsInput } from "./aggregate.js"

/**
 * Flakiest-tool signal: the sidecars' per-stage tool tallies rolled up per
 * tool. The activity chips show raw counts per stage section; this answers the
 * cross-run question — "which tool fails most" — that no single run can. Sorted
 * most-failing first so the finding is the first row.
 */
export const toolStats = (inputs: readonly RunMetricsInput[]): readonly ToolStats[] => {
  const byTool = new Map<string, { calls: number; errors: number; runs: Set<string> }>()

  for (const input of inputs) {
    if (!input.sidecar) continue
    for (const entry of input.sidecar.runs) {
      for (const sample of entry.samples) {
        for (const usage of sample.tools ?? []) {
          const acc = byTool.get(usage.tool) ?? { calls: 0, errors: 0, runs: new Set<string>() }
          acc.calls += usage.count
          acc.errors += usage.errors
          acc.runs.add(input.id)
          byTool.set(usage.tool, acc)
        }
      }
    }
  }

  return [...byTool.entries()]
    .map(([tool, acc]) => ({
      tool,
      calls: acc.calls,
      errors: acc.errors,
      errorRate: acc.calls === 0 ? null : acc.errors / acc.calls,
      runsCovered: acc.runs.size,
    }))
    .sort((a, b) => b.errors - a.errors || b.calls - a.calls || a.tool.localeCompare(b.tool))
}
