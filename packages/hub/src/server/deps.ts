import type { Client, Log, Shell } from "@agentic-loop/core/host"

/**
 * Everything a route handler needs, injected — handlers stay pure functions
 * of (deps, request) so tests drive them with fixture substrates and no
 * sockets. main.ts builds the real one.
 */
export interface HubDeps {
  /** Absolute repo root the hub serves (where .agentic-loop.json / docs/tasks live). */
  readonly directory: string
  readonly tasksDir: string
  readonly loopsDir: string
  /** Claude Code transcript root (~/.claude/projects) for token joins. */
  readonly projectsDir: string
  /** opencode SQLite store for legacy token backfill. */
  readonly opencodeDbPath: string
  readonly client: Client
  readonly sh: Shell
  readonly log: Log
}
