import { parseRunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { HubDeps } from "../deps.js"
import { ok, type JsonResponse } from "../http.js"
import { mapBounded, readText } from "../io.js"
import { aggregateMetrics, type RunMetricsInput } from "../metrics/aggregate.js"

/**
 * Cross-run loop health: `GET /api/metrics`.
 *
 * IO only — list the run logs, read each one's `.md` and `.metrics.json`, hand
 * the parsed pair to the pure `aggregateMetrics`. The route takes no path
 * parameter, so unlike `getRunDetail` it has no `isSafeId` surface; its only
 * untrusted input is `?repo=`, which `main.ts`'s `pickRepo` resolves against the
 * registry before a handler ever runs.
 *
 * Token numbers come from the sidecars directly rather than `resolveRunTokens`:
 * see the rationale in `metrics/cache.ts` — the transcript fallback would make
 * the cache ratio a quotient of two correlated estimates.
 */

export const getMetrics = async (deps: HubDeps): Promise<JsonResponse> => {
  const listed = await deps.client.file
    .list({ query: { path: `${deps.tasksDir}/runs`, directory: deps.directory } })
    .catch(() => null)
  const ids = (listed?.data ?? [])
    .filter((n) => n.type === "file" && n.name.endsWith(".md"))
    .map((n) => n.name.replace(/\.md$/, ""))

  // Every run's two files fetched with bounded concurrency: this route touches
  // the whole of runs/, so a serial loop would scale its latency with the
  // backlog's whole history — but an unbounded fan-out materializes every log
  // in memory at once. Each run is parsed as it lands so the raw content is
  // released before the next read.
  const results = await mapBounded(ids, 16, async (id) => {
    const [log, sidecar] = await Promise.all([
      readText(deps, `${deps.tasksDir}/runs/${id}.md`),
      readText(deps, `${deps.tasksDir}/runs/${id}.metrics.json`),
    ])
    if (log === null) return { id, input: null }
    const input: RunMetricsInput = { id, log: parseRunLog(log), sidecar: sidecar === null ? null : parseRunMetrics(sidecar) }
    return { id, input }
  })
  const inputs = results.flatMap((r) => (r.input ? [r.input] : []))
  // Listed but unreadable runs are reported rather than dropped, so a permission
  // problem or a dangling link shows up instead of shrinking the denominator.
  const skipped = results.flatMap((r) => (r.input ? [] : [r.id]))

  return ok(aggregateMetrics(inputs, skipped))
}
