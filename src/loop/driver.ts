import type { PluginInput } from "@opencode-ai/plugin"
import type { Action, Config, LoopState } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  composeArgs,
  createState,
  getLoop,
  resume,
  setLoop,
} from "./state.ts"

/**
 * Impure orchestration for the agentic loop. Thin glue over the pure helpers in
 * `state.ts`.
 *
 * Stepping is **sequential**: `client.session.command` resolves with the
 * completed stage's assistant message, so the driver fires a stage, captures its
 * output, feeds it back into the pure `advanceOnIdle` decision, and repeats until
 * a non-`fire` action (gate / done / stop). `session.idle` is used only as the
 * trigger to begin a drive once the `/loop` command's own turn settles; a pending
 * marker selects what to run and a driving lock prevents re-entrancy from the
 * idle events the driver's own commands generate.
 */

type Client = PluginInput["client"]

type Pending = { readonly kind: "start"; readonly goal: string } | { readonly kind: "proceed" }

const pending = new Map<string, Pending>()
const driving = new Set<string>()

const toast = (client: Client, message: string, variant: "info" | "success" | "warning" | "error") =>
  client.tui.showToast({ body: { message, variant } }).catch(() => {})

/** Fire a stage command and return the assistant text it produced. */
const runStage = async (client: Client, sessionID: string, stage: string, args: string): Promise<string> => {
  const res = await client.session.command({
    path: { id: sessionID },
    body: { command: stage, arguments: args },
  })
  const parts = res.data?.parts ?? []
  return parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

/** Run the stage chain from `first` until the pure logic yields a gate/done/stop. */
const drive = async (
  client: Client,
  sessionID: string,
  config: Config,
  first: { state: LoopState; action: Action },
): Promise<void> => {
  let step = first
  while (step.action.kind === "fire") {
    setLoop(sessionID, step.state)
    const { stage, arguments: args } = step.action
    const output = await runStage(client, sessionID, stage, args)
    step = advanceOnIdle(step.state, config, output)
  }

  const { state, action } = step
  switch (action.kind) {
    case "gate":
      setLoop(sessionID, state)
      await toast(client, action.message, "info")
      return
    case "done":
      clearLoop(sessionID)
      await toast(client, action.message, "success")
      return
    case "stop":
      clearLoop(sessionID)
      await toast(client, action.message, "warning")
      return
    case "noop":
      return
  }
}

const firstStep = (state: LoopState): { state: LoopState; action: Action } => ({
  state,
  action: { kind: "fire", stage: state.stage, arguments: composeArgs(state, state.stage) },
})

/**
 * Consume any pending loop work for a session that just went idle. Guarded so the
 * idle events the driver's own commands generate do not re-enter it.
 */
export const onIdle = async (client: Client, sessionID: string, config: Config): Promise<void> => {
  const work = pending.get(sessionID)
  if (!work || driving.has(sessionID)) return
  pending.delete(sessionID)
  driving.add(sessionID)
  try {
    if (work.kind === "start") {
      await drive(client, sessionID, config, firstStep(createState(work.goal)))
    } else {
      const state = getLoop(sessionID)
      if (state?.paused) await drive(client, sessionID, config, resume(state))
    }
  } catch (err) {
    clearLoop(sessionID)
    await toast(client, `Loop error: ${(err as Error).message}`, "error")
  } finally {
    driving.delete(sessionID)
  }
}

// --- /loop command handling (parses the mode; deferred work runs on next idle) ---

/** Parse and handle a `/loop ...` command. Returns true if it was a loop command. */
export const handleCommand = async (
  client: Client,
  sessionID: string,
  args: string,
): Promise<void> => {
  const arg = args.trim()
  const lower = arg.toLowerCase()

  if (lower === "go" || lower === "approve") {
    const state = getLoop(sessionID)
    if (!state) return void (await toast(client, "No active loop. Start one with /loop <goal>.", "warning"))
    if (!state.paused) return void (await toast(client, "Loop is not waiting for approval.", "info"))
    pending.set(sessionID, { kind: "proceed" })
    await toast(client, "Approved — building…", "info")
    return
  }

  if (lower === "stop" || lower === "abort") {
    pending.delete(sessionID)
    const existed = clearLoop(sessionID)
    await toast(client, existed ? "Loop stopped." : "No active loop to stop.", "info")
    return
  }

  if (lower === "status" || lower === "") {
    const state = getLoop(sessionID)
    if (!state) return void (await toast(client, "No active loop.", "info"))
    const where = state.paused ? `${state.stage} (paused at gate)` : state.stage
    await toast(client, `Loop: ${where} · iteration ${state.iteration + 1} · goal: ${state.goal}`, "info")
    return
  }

  // Anything else is a goal → start a new loop (replacing any existing one).
  clearLoop(sessionID)
  pending.set(sessionID, { kind: "start", goal: arg })
  await toast(client, "Loop started — exploring then planning…", "info")
}
