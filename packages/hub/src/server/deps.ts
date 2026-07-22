import type { Client, Log, Shell } from "@agentic-workflow/core/host"
import type { Config } from "@agentic-workflow/core/workflow/state"
import type { KindBoardInfo } from "../shared/api.js"

/**
 * Everything a route handler needs, injected — handlers stay pure functions
 * of (deps, request) so tests drive them with fixture substrates and no
 * sockets. main.ts builds the real one.
 */
export interface HubDeps {
  /** Absolute repo root the hub serves (where .agentic-workflow.json / docs/tasks live). */
  readonly directory: string
  readonly tasksDir: string
  /** Per-kind dashboard metadata for this repo's enabled kinds (see kindboard.ts). */
  readonly boards: readonly KindBoardInfo[]
  /**
   * This repo's parsed config. Core's shared entry points take a whole `Config`
   * (`GateCtx.config`), so the hub carries one rather than rebuilding it per
   * call. `tasksDir` and `boards` above are derived from it at build time and
   * kept for convenience — this is the single source, they are not independent
   * truth. Swapped wholesale on reload (see main.ts), never mutated in place.
   */
  readonly config: Config
  readonly workflowsDir: string
  /** Claude Code transcript root (~/.claude/projects) for token joins. */
  readonly projectsDir: string
  /** opencode SQLite store for legacy token backfill. */
  readonly opencodeDbPath: string
  readonly client: Client
  readonly sh: Shell
  readonly log: Log
  /**
   * Set only when this repo's `.agentic-workflow.json` failed to parse/validate
   * at initial build and the deps fell back to defaults. The board renders on the
   * default (engineering) shape and the Config tab surfaces the issue so it can
   * be fixed in place. Cleared on a successful reload. Absent = healthy.
   */
  readonly configError?: string
  /**
   * Re-read this repo's `.agentic-workflow.json` and swap its deps. Config is read
   * once at startup, so a route that writes the config must call this or the
   * server keeps serving the old one until a restart. Optional: test fixtures
   * and read-only routes have no use for it. Returns false when the new config
   * was unusable and the last good one was kept.
   */
  readonly reloadRepo?: () => Promise<boolean>
}
