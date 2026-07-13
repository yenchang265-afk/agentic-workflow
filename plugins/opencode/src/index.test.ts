import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { AgenticLoop } from "./index.ts"
import { loadFailureHooks, loadFailureMessage } from "./load-failure.ts"
import * as entry from "./index.ts"

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
  // Generous race: the entry dynamically imports impl.ts (whole driver graph),
  // which can take seconds cold on a slow filesystem — the deadlock this test
  // guards against is an infinite hang, not slow module loading.
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000))
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

test("an agentic-loop:engineering gate verb is dispatched (it triggers a config read)", async () => {
  const calls: string[] = []
  const hooks = await AgenticLoop(makeInput(calls))
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))
  // The hanging fake client never resolves file.read, so the handler blocks
  // after recording the call — racing a timeout is enough to observe dispatch.
  await Promise.race([
    hooks["command.execute.before"]?.({ command: "agentic-loop:engineering", sessionID: "ses_x", arguments: "approve x" } as never, {} as never),
    timeout,
  ])
  assert.ok(calls.includes("file.read"), "an /agentic-loop:engineering gate verb must reach the plugin handler")
})

test("the plugin exposes dispose (watch-timer cleanup) and no loop_begin tool", async () => {
  const hooks = await AgenticLoop(makeInput([]))
  assert.notEqual(hooks, undefined)
  assert.equal(typeof (hooks as { dispose?: unknown }).dispose, "function")
  const tools = (hooks as { tool?: Record<string, unknown> }).tool ?? {}
  assert.ok(!("loop_begin" in tools), "loop_begin was removed with the old free-text command mode")
  assert.ok("loop_verdict" in tools)
  await (hooks as { dispose: () => Promise<void> }).dispose() // must not throw with no timers
})

test("the entry module exports ONLY plugin factories (opencode calls every export as one)", () => {
  // Regression: exporting loadFailureHooks from index.ts made opencode call it
  // as Plugin(input, options) — its hooks closed over client=options
  // (undefined) and threw `client.app` on EVERY command, killing the turn.
  assert.deepEqual(Object.keys(entry).sort(), ["AgenticLoop"])
})

// --- fail-loud fallback (impl.ts failed to import: stale/missing core dist) ---

const makeFallbackClient = () => {
  const toasts: string[] = []
  const logs: string[] = []
  const client = {
    tui: {
      showToast: (o: { body: { message: string } }) => {
        toasts.push(o.body.message)
        return Promise.resolve()
      },
    },
    app: {
      log: (o: { body: { message: string } }) => {
        logs.push(o.body.message)
        return Promise.resolve()
      },
    },
  }
  return { client: client as unknown as PluginInput["client"], toasts, logs }
}

test("load-failure message carries the first error line and the rebuild hint", () => {
  const msg = loadFailureMessage(new Error("Cannot find module '…/dist/loop/gate.js'\nlong stack…"))
  assert.ok(msg.includes("Cannot find module"), msg)
  assert.ok(!msg.includes("long stack"), "only the first error line belongs in the toast")
  assert.ok(msg.includes("npm install"), "the message must tell the human how to rebuild")
})

test("fallback hooks surface the load error on agentic-loop commands only", async () => {
  const { client, toasts, logs } = makeFallbackClient()
  const hooks = loadFailureHooks(new Error("Cannot find module x"), client)

  await hooks["command.execute.before"]?.({ command: "help", sessionID: "ses_x", arguments: "" } as never, {} as never)
  assert.equal(toasts.length, 0, "non-loop commands must pass through silently")

  await hooks["command.execute.before"]?.(
    { command: "agentic-loop:engineering", sessionID: "ses_x", arguments: "approve f7k3" } as never,
    {} as never,
  )
  assert.equal(toasts.length, 1, "an agentic-loop command must toast the load failure")
  assert.ok(toasts[0]?.includes("failed to load"), toasts[0] ?? "(no toast)")
  assert.equal(logs.length, 1, "the load failure must also be logged")
})

test("fallback hooks never throw when the client itself is broken", async () => {
  const broken = {
    tui: { showToast: () => Promise.reject(new Error("tui down")) },
    app: { log: () => Promise.reject(new Error("log down")) },
  } as unknown as PluginInput["client"]
  const hooks = loadFailureHooks(new Error("boom"), broken)
  await hooks["command.execute.before"]?.(
    { command: "agentic-loop:engineering", sessionID: "ses_x", arguments: "approve f7k3" } as never,
    {} as never,
  )
})
