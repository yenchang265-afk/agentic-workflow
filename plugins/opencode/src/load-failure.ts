import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { overrideCommandPrompt, refusalPrompt } from "./command-prompt.ts"

/**
 * The fail-loud fallback for a plugin whose impl.ts could not be imported
 * (stale/missing @agentic-workflow/core build). Lives OUTSIDE index.ts on
 * purpose: opencode treats every export of the plugin entry module as a
 * plugin factory and calls it with (input, options) — exporting these from
 * index.ts registered `loadFailureHooks` itself as a second "plugin" whose
 * hooks closed over `client = options` (undefined) and threw
 * `TypeError: undefined is not an object (evaluating 'client.app')` on every
 * command, killing the whole command turn. The entry may export ONLY real
 * plugin factories.
 */

const REBUILD_HINT = "Rebuild it: run `pnpm install` at the agentic-workflow repo root (or `pnpm --filter @agentic-workflow/core run build`), then restart opencode."

/** The user-facing load-failure message: first error line + rebuild hint. Pure. */
export const loadFailureMessage = (err: unknown): string => {
  const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.trim() || "unknown error"
  return `agentic-workflow plugin failed to load: ${detail}. ${REBUILD_HINT}`
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
    "command.execute.before": async (input, output) => {
      if (!/^agentic-workflow:/.test(input.command)) return
      // Override FIRST, then report. The reporting calls are client fetches and
      // the SDK sets `req.timeout = false`; their `.catch()` guards a rejection,
      // not a hang. Awaited ahead of the override they could park this hook
      // forever, and opencode awaits `command.execute.before` with no timeout of
      // its own — the command would die before `Session.prompt` with zero output,
      // the "first invocation swallowed, retry works" symptom this module exists
      // to make impossible. A stale core dist plus a stalled server is not a
      // hypothetical pairing: it is this module's own reason to exist.
      //
      // The toast is for the human; the model never sees it and would other-
      // wise run the still-rendered template as a plain prompt — exactly the
      // "reports a task move that never happened" failure index.ts warns about.
      overrideCommandPrompt(output, refusalPrompt("it failed to load.", message))
      void client.app.log({ body: { service: "agentic-workflow", level: "error", message } }).catch(() => {})
      void client.tui.showToast({ body: { message, variant: "error" } }).catch(() => {})
    },
  }
}
