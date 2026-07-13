import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"

/**
 * agentic-loop plugin entry.
 *
 * The real plugin lives in `impl.ts`, which transitively imports
 * `@agentic-loop/core`'s built `dist/`. When that build is stale (e.g. a
 * refactor added a core module and `npm install` / `npm run build -w
 * @agentic-loop/core` never re-ran), a static import chain would throw
 * ERR_MODULE_NOT_FOUND during opencode's plugin scan and the plugin would
 * vanish SILENTLY — while the `/agentic-loop:*` command markdowns (registered
 * independently) keep rendering, so a gate verb like `approve <id>` becomes a
 * plain prompt and a weak model happily reports a task-file move that never
 * happened.
 *
 * This entry therefore imports NOTHING from core statically and loads
 * `impl.ts` dynamically inside the factory. On load failure it returns a
 * minimal fallback plugin whose only job is to fail LOUDLY: every
 * `/agentic-loop:*` command toasts + logs the load error with the rebuild
 * instruction, so no gate verb can silently no-op again.
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

// Kick the impl load off at module-import time (opencode's plugin scan), so
// its cost is paid before the factory runs and a failure is captured — never
// an unhandled rejection.
const impl = import("./impl.ts").then(
  (m) => ({ ok: true as const, make: m.makeAgenticLoop }),
  (err: unknown) => ({ ok: false as const, err }),
)

export const AgenticLoop: Plugin = async (input, options) => {
  const loaded = await impl
  if (loaded.ok) return loaded.make(input, options)
  return loadFailureHooks(loaded.err, input.client)
}
