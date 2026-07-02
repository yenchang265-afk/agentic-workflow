import type { Plugin } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, loadConfig } from "./config.ts"
import * as driver from "./loop/driver.ts"
import { hasLoop } from "./loop/state.ts"

/**
 * agentic-loop
 *
 * opencode plugin that drives the engineering workflow as an automatic loop:
 *
 *   define → plan → build → verify → review → ship
 *
 * `/loop <goal>` starts it; the plugin runs define then plan, pauses for a
 * human plan-approval gate (`/loop go`), then runs build → verify → review,
 * pauses again for a human ship-approval gate (`/loop go`), then runs ship.
 * A verify FAIL re-plans; a review FAIL re-builds — both within the
 * iteration cap. The control surface lives in `loop/driver.ts`; the pure
 * state machine in `loop/state.ts`.
 */
export const AgenticLoop: Plugin = async ({ client, directory, $ }) => {
  const service = "agentic-loop"

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service, level, message } })

  // Everything the driver needs from the host, bundled once. `$` (Bun shell) is
  // used to move task files between status folders.
  const deps: driver.Deps = { client, $, directory, log }

  // Load loop config once; fall back to defaults (and warn) on misconfig so a bad
  // config file degrades rather than breaking the plugin entirely.
  let config = DEFAULT_CONFIG
  try {
    config = await loadConfig(client, directory)
  } catch (err) {
    await log("warn", `using default config: ${(err as Error).message}`)
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const { sessionID } = event.properties
      await driver.onIdle(deps, sessionID, config)
    },

    "command.execute.before": async (input) => {
      if (input.command !== "loop") return
      await driver.handleCommand(deps, input.sessionID, input.arguments, config)
    },

    "tool.execute.before": async (input) => {
      // Only trace tool calls while a loop is actively driving this session.
      if (hasLoop(input.sessionID)) {
        await log("info", `tool ${input.tool} starting (call ${input.callID})`)
      }
    },
  }
}
