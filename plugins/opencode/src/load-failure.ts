import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * The fail-loud fallback for a plugin whose impl.ts could not be imported
 * (stale/missing @agentic-loop/core build). Lives OUTSIDE index.ts on
 * purpose: opencode treats every export of the plugin entry module as a
 * plugin factory and calls it with (input, options) — exporting these from
 * index.ts registered `loadFailureHooks` itself as a second "plugin" whose
 * hooks closed over `client = options` (undefined) and threw
 * `TypeError: undefined is not an object (evaluating 'client.app')` on every
 * command, killing the whole command turn. The entry may export ONLY real
 * plugin factories.
 */

const REBUILD_HINT = "Rebuild it: run `npm install` at the agentic-loop repo root (or `npm run build -w @agentic-loop/core`), then restart opencode."

/** The user-facing load-failure message: first error line + rebuild hint. Pure. */
export const loadFailureMessage = (err: unknown): string => {
  const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.trim() || "unknown error"
  return `agentic-loop plugin failed to load: ${detail}. ${REBUILD_HINT}`
}

/**
 * The fallback hooks returned when `impl.ts` can't be imported: intercept the
 * plugin's own commands and surface the load error (toast for the human, log
 * for the record) instead of letting the command template run as if the
 * deterministic gate work had happened. No client call happens at factory
 * time — opencode's plugin init deadlocks on them; hooks fire after bootstrap.
 */
export const loadFailureHooks = (err: unknown, client: PluginInput["client"]): Hooks => {
  const message = loadFailureMessage(err)
  return {
    "command.execute.before": async (input) => {
      if (!/^agentic-loop:/.test(input.command)) return
      await client.app.log({ body: { service: "agentic-loop", level: "error", message } }).catch(() => {})
      await client.tui.showToast({ body: { message, variant: "error" } }).catch(() => {})
    },
  }
}
