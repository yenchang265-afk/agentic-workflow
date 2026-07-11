import { enabledLoopKinds } from "@agentic-loop/core/config"
import type { Config } from "@agentic-loop/core/loop/state"
import { loadManifest } from "@agentic-loop/core/manifest/load"
import { gateStatuses } from "@agentic-loop/core/manifest/schema"
import type { Log } from "@agentic-loop/core/host"
import type { KindBoardInfo } from "../shared/api.js"

/**
 * Per-kind dashboard metadata, derived at startup from a repo's enabled loop
 * kinds and their manifests. The monitor renders one view per kind: backlog
 * kinds get a board whose columns and gate highlights come from the manifest
 * (not the hardcoded engineering shape), PR-shaped kinds get a ledger panel.
 *
 * Kinds whose manifest fails to load are skipped with a warning rather than
 * failing the whole hub — a repo may enable a kind this clone's core doesn't
 * ship. Note: two backlog kinds sharing status-folder names in one tasksDir
 * is untested territory; boards render per kind either way.
 */
export const kindBoards = (loopsDir: string, config: Config, log?: Log): KindBoardInfo[] => {
  const boards: KindBoardInfo[] = []
  for (const kind of enabledLoopKinds(config)) {
    try {
      const { manifest } = loadManifest(loopsDir, kind)
      const source = manifest.workSource
      boards.push({
        kind,
        description: manifest.description,
        sourceType: source.type,
        statuses: source.type === "backlog" ? source.statuses : [],
        gateStatuses: gateStatuses(manifest),
        pools: source.type === "backlog" ? source.pools.map((p) => p.status) : [],
      })
    } catch (err) {
      log?.("warn", `kind "${kind}": manifest not loadable — skipped from the monitor (${(err as Error).message})`)
    }
  }
  return boards
}

/** Every status folder any enabled backlog kind declares — the watcher's scan set. */
export const unionStatuses = (boards: readonly KindBoardInfo[]): string[] => [
  ...new Set(boards.flatMap((b) => b.statuses)),
]

/** Every gate status any enabled kind declares — the watcher's gate-event set. */
export const unionGates = (boards: readonly KindBoardInfo[]): string[] => [
  ...new Set(boards.flatMap((b) => b.gateStatuses)),
]
