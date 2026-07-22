import type { HubDeps } from "./deps.js"
import type { Repo } from "./repo.js"
import { resolveNewRepos } from "./repos.js"

/**
 * Live registry of monitored repos. The startup set is resolved once in
 * main.ts, but a directory under a configured pattern can become loop-enabled
 * (gain `.agentic-workflow.json` / `docs/tasks`) while the hub runs — `rescan()`
 * re-evaluates the patterns and registers newcomers without a restart.
 *
 * Append-only by design: a vanished directory stays registered (its watcher
 * and scans are already harmless no-ops), because a transiently unavailable
 * mount — a WSL DrvFs hiccup, a network drive — is indistinguishable from a
 * deletion, and tearing down a healthy repo over a hiccup is worse than a
 * stale picker entry.
 *
 * Lives here rather than in main.ts because main.ts is a side-effecting entry
 * script, so nothing in it can be imported by a test.
 */

export interface RepoRegistryOptions {
  readonly patterns: readonly string[]
  readonly cwd: string
  readonly initial: readonly Repo[]
  /** Build a Repo for a newly discovered directory (main.ts passes makeRepo). */
  readonly create: (id: string, directory: string) => Promise<Repo>
  /** Fired once per newly registered repo, after it is queryable via byId. */
  readonly onAdded: (repo: Repo) => void
  readonly log: HubDeps["log"]
}

export interface RepoRegistry {
  /** Live, append-only — safe to hold `repos[0]` as the default repo. */
  readonly repos: readonly Repo[]
  readonly byId: ReadonlyMap<string, Repo>
  /** Re-resolve patterns; register newly loop-enabled dirs. No-op while one is in flight. */
  readonly rescan: () => Promise<void>
}

export const makeRepoRegistry = (opts: RepoRegistryOptions): RepoRegistry => {
  const repos: Repo[] = [...opts.initial]
  const byId = new Map(repos.map((r) => [r.id, r]))
  const warned = new Set<string>()
  let scanning = false

  const rescan = async (): Promise<void> => {
    // Node is single-threaded, so the only duplicate-registration hazard is
    // two rescans overlapping across the `await create` gap below.
    if (scanning) return
    scanning = true
    try {
      const knownDirs = new Set(repos.map((r) => r.directory))
      const takenIds = new Set(byId.keys())
      for (const { id, directory } of resolveNewRepos(opts.patterns, opts.cwd, knownDirs, takenIds)) {
        try {
          const repo = await opts.create(id, directory)
          repos.push(repo)
          byId.set(repo.id, repo)
          opts.onAdded(repo)
        } catch (err) {
          // Warn once per directory, not every tick; retried on later rescans.
          if (!warned.has(directory)) {
            warned.add(directory)
            opts.log("warn", `failed to register ${directory} — will retry: ${(err as Error).message}`)
          }
        }
      }
    } finally {
      scanning = false
    }
  }

  return { repos, byId, rescan }
}
