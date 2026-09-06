import { parseWindow, readRunInputs } from "@agentic-workflow/core/workflow/metrics-aggregate"
import type { HubDeps } from "../deps.js"
import { badRequest, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { aggregateMetrics } from "../metrics/aggregate.js"

/**
 * Cross-run loop health: `GET /api/metrics?window=30d&kind=engineering`.
 *
 * IO only — every run's `.md` and `.metrics.json` are read and parsed by
 * core's `readRunInputs` (the same reader both hosts' `metrics` verb uses,
 * design 64), then handed to the pure `aggregateMetrics`. The window narrows
 * the population before anything is counted; `all` (the default) is the
 * pre-design-64 behaviour. `?repo=` is resolved by `main.ts`'s `pickRepo`
 * before a handler ever runs; `window`/`kind` are validated here and a bad
 * value is a 400, never silently `all`.
 *
 * Token numbers come from the sidecars directly rather than `resolveRunTokens`:
 * see the rationale in `metrics/cache.ts` — the transcript fallback would make
 * the cache ratio a quotient of two correlated estimates.
 */

const KIND_RE = /^[a-z][a-z0-9-]{0,63}$/

export const getMetrics = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const windowText = req.query.get("window") ?? "all"
  const window = parseWindow(windowText)
  if (!window) return badRequest(`window must be 7d / 30d / 90d / all (a day count), got "${windowText}"`)
  const kind = req.query.get("kind") ?? ""
  if (kind && !KIND_RE.test(kind)) return badRequest(`invalid kind "${kind}"`)
  const days = window.since === undefined ? null : Math.round((Date.now() - window.since) / 86_400_000)
  const { inputs, skipped } = await readRunInputs(deps.client, deps.directory, deps.tasksDir)
  return ok(aggregateMetrics(inputs, skipped, { ...window, ...(kind ? { kind } : {}), days }))
}
