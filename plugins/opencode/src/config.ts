import { z } from "zod"
import {
  ConfigSchema as CoreConfigSchema,
  loadConfigWith,
  parseConfigWith,
  type LoadConfigOptions,
} from "@agentic-workflow/core/config"
import type { Client } from "@agentic-workflow/core/host"
import type { Config as CoreConfig } from "@agentic-workflow/core/workflow/state"
import { cronError } from "./workflow/trigger.js"

/**
 * The OpenCode plugin's config: the shared core schema plus the fields only an
 * autonomous in-process driver can honor (the MCP server has no timers, so
 * `watchIntervalMinutes` lives here, not in core).
 */

// `safeExtend`: the core schema carries a cross-field refinement (codePlatform
// "ado" requires the `ado` section), which plain `.extend()` would reject.
export const ConfigSchema = CoreConfigSchema.safeExtend({
  /**
   * Default polling cadence for `/agentic-workflow:engineering watch`: a timer at this interval scans
   * `in-progress/` for claimable approved tasks while the session is idle.
   * Overridable per-session via `/agentic-workflow:engineering watch <interval>` (e.g. `30s`, `2h`).
   */
  watchIntervalMinutes: z.number().positive().max(1440).default(5),
}).superRefine((c, ctx) => {
  // Core validates trigger shape only; this host actually schedules cron
  // triggers, so misconfig must fail at load, not at `watch` time.
  for (const [kind, section] of Object.entries(c.workflows)) {
    const trigger = section.trigger
    if (trigger?.type !== "cron") continue
    const error = cronError(trigger.schedule)
    if (error) {
      ctx.addIssue({
        code: "custom",
        path: ["workflows", kind, "trigger", "schedule"],
        message: `not a valid cron expression: ${error}`,
      })
    }
  }
})

export interface Config extends CoreConfig {
  readonly watchIntervalMinutes: number
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => parseConfigWith(ConfigSchema, raw)

/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export const loadConfig = (client: Client, directory: string, opts?: LoadConfigOptions): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory, opts)

export { applyAdoPatEnv } from "@agentic-workflow/core/config"
