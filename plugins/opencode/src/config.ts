import { z } from "zod"
import { ConfigSchema as CoreConfigSchema, loadConfigWith, parseConfigWith } from "@agentic-loop/core/config"
import type { Client } from "@agentic-loop/core/host"
import type { Config as CoreConfig } from "@agentic-loop/core/loop/state"

/**
 * The OpenCode plugin's config: the shared core schema plus the fields only an
 * autonomous in-process driver can honor (the MCP server has no timers, so
 * `watchIntervalMinutes` lives here, not in core).
 */

// `safeExtend`: the core schema carries a cross-field refinement (codePlatform
// "ado" requires the `ado` section), which plain `.extend()` would reject.
export const ConfigSchema = CoreConfigSchema.safeExtend({
  /**
   * Default polling cadence for `/agent-loop watch`: a timer at this interval scans
   * `in-progress/` for claimable approved tasks while the session is idle.
   * Overridable per-session via `/agent-loop watch <interval>` (e.g. `30s`, `2h`).
   */
  watchIntervalMinutes: z.number().positive().max(1440).default(5),
})

export interface Config extends CoreConfig {
  readonly watchIntervalMinutes: number
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => parseConfigWith(ConfigSchema, raw)

/** Load config from the repo root, falling back to defaults when the file is absent. */
export const loadConfig = (client: Client, directory: string): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory)

export { applyAdoPatEnv } from "@agentic-loop/core/config"
