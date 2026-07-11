import { listLoopKinds } from "@agentic-loop/core/manifest/load"
import type { ManualFreshnessResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { ok, type JsonResponse } from "../http.js"
import { checkFreshness, extractMentions, parseArgumentHint, type CommandSurface } from "../manual-check.js"

/** Manual serving support: the freshness diff between docs/manual.html and the real command surface. */

export const MANUAL_PATH = "docs/manual.html"

const readRel = async (deps: HubDeps, rel: string): Promise<string | null> => {
  const res = await deps.client.file.read({ query: { path: rel, directory: deps.directory } }).catch(() => null)
  return res?.data?.content ?? null
}

export const getManualFreshness = async (deps: HubDeps): Promise<JsonResponse> => {
  const manual = await readRel(deps, MANUAL_PATH)
  if (manual === null) {
    const response: ManualFreshnessResponse = { available: false, warnings: [] }
    return ok(response)
  }
  const surfaces: CommandSurface[] = []
  for (const kind of listLoopKinds(deps.loopsDir)) {
    const claude = await readRel(deps, `plugins/claude/commands/${kind}.md`)
    if (claude) surfaces.push({ kind, host: "claude", verbs: parseArgumentHint(claude) })
    const opencode = await readRel(deps, `plugins/opencode/commands/agentic-loop-${kind}.md`)
    if (opencode) surfaces.push({ kind, host: "opencode", verbs: parseArgumentHint(opencode) })
  }
  const knownVerbs = new Set(surfaces.flatMap((s) => [...s.verbs]))
  const response: ManualFreshnessResponse = {
    available: true,
    warnings: checkFreshness(extractMentions(manual, knownVerbs), surfaces),
  }
  return ok(response)
}
