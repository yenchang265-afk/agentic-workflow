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
 * The OpenCode plugin's config: the shared core schema, plus the one validation
 * only this host can perform.
 *
 * There are no host-only FIELDS any more. `watchIntervalMinutes` used to live
 * here — a global default watch cadence — and was retired because two rungs
 * above it already covered every use: the `watch <interval>` argument
 * (per session) and `workflows.<kind>.trigger.intervalMinutes` (persistent, per
 * kind, and in core so every host honors it). A single global cadence applied to
 * every watched kind at once, which is rarely what anyone wants: a `dep-sitter`
 * does not need an `engineering` loop's polling rate. The default it carried is
 * now `DEFAULT_WATCH_INTERVAL_MINUTES` in the driver, and
 * `RETIRED_CONFIG_KEYS` warns anyone whose config still sets it.
 */
export const ConfigSchema = CoreConfigSchema.superRefine((c, ctx) => {
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

export type Config = CoreConfig

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => parseConfigWith(ConfigSchema, raw)

/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export const loadConfig = (client: Client, directory: string, opts?: LoadConfigOptions): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory, opts)
