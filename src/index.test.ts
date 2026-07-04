import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { AgenticLoop } from "./index.ts"

/**
 * The plugin initializer runs inside opencode's instance bootstrap. Any
 * `client` call made there is a request back into the same still-bootstrapping
 * instance and deadlocks opencode startup (the TUI never opens). These tests
 * pin the fix: init must complete without touching the client at all.
 */

const hang = () => new Promise<never>(() => {})

const makeInput = (calls: string[]): PluginInput => {
  // Every client method records the call and never resolves, simulating the
  // bootstrap deadlock: if init awaits any of them, the test times out.
  const client = {
    file: {
      read: () => {
        calls.push("file.read")
        return hang()
      },
    },
    app: {
      log: () => {
        calls.push("app.log")
        return hang()
      },
    },
  }
  return { client, directory: "/repo", $: undefined } as unknown as PluginInput
}

test("plugin init resolves without any client call (no bootstrap deadlock)", async () => {
  const calls: string[] = []
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000))
  const hooks = await Promise.race([AgenticLoop(makeInput(calls)), timeout])

  assert.notEqual(hooks, "timeout", "plugin init blocked on a client call — this deadlocks opencode startup")
  assert.deepEqual(calls, [], "plugin init must not call the opencode client during bootstrap")
})

test("non-loop commands pass through without loading config", async () => {
  const calls: string[] = []
  const hooks = await AgenticLoop(makeInput(calls))
  await hooks["command.execute.before"]?.(
    { command: "help", sessionID: "ses_x", arguments: "" } as never,
    {} as never,
  )
  assert.deepEqual(calls, [], "a non-loop command must not trigger a config read")
})
