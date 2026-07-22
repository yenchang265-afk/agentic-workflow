import type { Plugin } from "@opencode-ai/plugin"
import { loadFailureHooks } from "./load-failure.ts"

/**
 * agentic-workflow plugin entry.
 *
 * The real plugin lives in `impl.ts`, which transitively imports
 * `@agentic-workflow/core`'s built `dist/`. When that build is stale (e.g. a
 * refactor added a core module and `npm install` / `npm run build -w
 * @agentic-workflow/core` never re-ran), a static import chain would throw
 * ERR_MODULE_NOT_FOUND during opencode's plugin scan and the plugin would
 * vanish SILENTLY — while the `/agentic-workflow:*` command markdowns (registered
 * independently) keep rendering, so a gate verb like `approve <id>` becomes a
 * plain prompt and a weak model happily reports a task-file move that never
 * happened.
 *
 * This entry therefore imports nothing from core statically and loads
 * `impl.ts` dynamically. On load failure it returns a minimal fallback plugin
 * (see load-failure.ts) that fails LOUDLY: every `/agentic-workflow:*` command
 * toasts + logs the load error with the rebuild instruction.
 *
 * IMPORTANT: this module may export ONLY plugin factories. opencode calls
 * every export of the entry module as `Plugin(input, options)` — a stray
 * helper export becomes a broken second plugin whose thrown hook kills every
 * command turn. Helpers live in load-failure.ts.
 */

// Kick the impl load off at module-import time (opencode's plugin scan), so
// its cost is paid before the factory runs and a failure is captured — never
// an unhandled rejection.
const impl = import("./impl.ts").then(
  (m) => ({ ok: true as const, make: m.makeAgenticWorkflow }),
  (err: unknown) => ({ ok: false as const, err }),
)

export const AgenticWorkflow: Plugin = async (input, options) => {
  const loaded = await impl
  if (loaded.ok) return loaded.make(input, options)
  return loadFailureHooks(loaded.err, input.client)
}
