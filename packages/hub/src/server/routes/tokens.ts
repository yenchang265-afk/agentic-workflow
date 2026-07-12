import type { TokensSummaryEntry, TokensSummaryResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { isSafeId, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { resolveRunTokens } from "../tokens/resolve.js"

/** Token usage views — per run and the roll-up across all runs. */

export const getRunTokens = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return notFound(`run ${id}`)
  const resolved = await resolveRunTokens(deps, id)
  if (!resolved) return notFound(`run ${id}`)
  return ok(resolved)
}

export const getTokensSummary = async (deps: HubDeps): Promise<JsonResponse> => {
  const listed = await deps.client.file
    .list({ query: { path: `${deps.tasksDir}/runs`, directory: deps.directory } })
    .catch(() => null)
  const ids = (listed?.data ?? [])
    .filter((n) => n.type === "file" && n.name.endsWith(".md"))
    .map((n) => n.name.replace(/\.md$/, ""))
  const runs: TokensSummaryEntry[] = []
  for (const id of ids) {
    const resolved = await resolveRunTokens(deps, id)
    if (!resolved || resolved.rows.length === 0) continue
    runs.push({
      id,
      input: resolved.totals.input + resolved.totals.cacheRead + resolved.totals.cacheWrite,
      output: resolved.totals.output + resolved.totals.reasoning,
      ...(resolved.cost !== undefined ? { cost: resolved.cost } : {}),
      estimated: resolved.rows.some((r) => r.estimated),
    })
  }
  runs.sort((a, b) => b.input + b.output - (a.input + a.output))
  const response: TokensSummaryResponse = { runs }
  return ok(response)
}
