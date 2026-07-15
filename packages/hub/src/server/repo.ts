import { loadConfig } from "@agentic-loop/core/config"
import type { Log } from "@agentic-loop/core/host"
import { defaultLoopsDir } from "@agentic-loop/core/manifest/dir"
import { STATUSES } from "@agentic-loop/core/task/store"
import type { HubDeps } from "./deps.js"
import { fsClient, sh } from "./fsclient.js"
import { kindBoards, unionGates, unionStatuses } from "./kindboard.js"
import { defaultOpencodeDbPath } from "./tokens/opencodedb.js"
import { defaultProjectsDir } from "./tokens/transcripts.js"
import type { WatcherOptions } from "./watch.js"

/**
 * One monitored repo and its deps, with the reload path that keeps them current.
 *
 * Lives here rather than in main.ts because main.ts is a side-effecting entry
 * script (it parses argv, binds a socket, and exits on bad input), so nothing in
 * it can be imported by a test. Reload has a safety rail worth proving — a
 * broken hand-edited config must never blank the board — and a rail that has
 * never run is not a rail.
 */

export const buildDeps = async (directory: string, log: Log): Promise<HubDeps> => {
  const config = await loadConfig(fsClient, directory)
  return {
    directory,
    tasksDir: config.tasksDir,
    boards: kindBoards(defaultLoopsDir(), config, log),
    config,
    loopsDir: defaultLoopsDir(),
    projectsDir: defaultProjectsDir(),
    opencodeDbPath: defaultOpencodeDbPath(),
    client: fsClient,
    sh,
    log,
  }
}

/**
 * What the watcher is built from. Scan every folder any enabled kind declares;
 * fall back to the engineering shape when no manifest loaded (e.g. a bare repo
 * with no kinds on disk).
 */
export const watchShape = (deps: HubDeps): WatcherOptions => {
  const statuses = unionStatuses(deps.boards)
  return {
    directory: deps.directory,
    tasksDir: deps.tasksDir,
    statuses: statuses.length > 0 ? statuses : STATUSES,
    gateStatuses: unionGates(deps.boards),
  }
}

export interface Repo {
  readonly id: string
  readonly directory: string
  /**
   * Swapped wholesale by `reload()`, never mutated in place. `scoped()` re-reads
   * this field per request, so a swap reaches every handler with no plumbing.
   */
  deps: HubDeps
  /**
   * Re-read `.agentic-loop.json` and rebuild this repo's deps. Config is
   * otherwise read once at startup, so without this every edit needs a restart.
   * Returns false when the new config is unusable, keeping the last good deps —
   * a broken hand-edit must never blank the board or kill the server.
   */
  reload: () => Promise<boolean>
}

/**
 * `onWatchShapeChanged` fires only when a reload moved `tasksDir` or the status
 * union: the watcher is constructed from both, so a config that changed either
 * leaves it watching the old folders forever. Not fired on the initial build.
 */
export const makeRepo = async (
  id: string,
  directory: string,
  log: Log,
  onWatchShapeChanged: (repo: Repo) => void = () => {},
): Promise<Repo> => {
  const repo: Repo = {
    id,
    directory,
    deps: await buildDeps(directory, log),
    reload: async () => {
      try {
        const next = await buildDeps(directory, log)
        const moved = JSON.stringify(watchShape(repo.deps)) !== JSON.stringify(watchShape(next))
        repo.deps = next
        if (moved) onWatchShapeChanged(repo)
        return true
      } catch (err) {
        log("warn", `config reload failed for ${id} — keeping the last good config: ${(err as Error).message}`)
        return false
      }
    },
  }
  return repo
}
