#!/usr/bin/env node
/**
 * PostToolUse hook: the PLAN GATE's follow-up question.
 *
 * When `workflow_advance` parks a plan, the MCP result already carries a `next`
 * line asking the model to put the Approve / Replan / Park question to the human
 * (mcp-server's `runPark`). That line is PROSE INSIDE DATA, and prose is precisely
 * what the orchestrating model does not reliably follow — the same reason
 * gate-ask.mjs exists rather than a sentence in the command body, and the same
 * reason `stageModels` is bound by a hook rather than asked for. So the harness
 * says it too, as a system reminder placed next to the tool result.
 *
 * It does not replace the result's `next`: the two say the same thing, and a host
 * or plugin version where this hook never runs keeps working exactly as before.
 *
 * FAILS OPEN ON EVERYTHING. Unparseable stdin, an envelope shape this build does
 * not know, a result that is not JSON, no `gate` descriptor (an older
 * mcp-server/dist), a host with no question tool — every one of them exits 0 and
 * emits nothing. A false silence costs the reminder; a false reminder would tell
 * the model to gate a task that never parked.
 *
 * No workflow-kind filter is needed, and adding one would be fixing a hole that
 * does not exist: core's `runPark` returns `park-free` for a task-less state, and
 * no sitter work item is task-backed, so the `gate: {kind: "plan"}` descriptor is
 * only ever emitted for an engineering park.
 *
 * The parsing half (`planGateOf`) is pure and dependency-free so it unit tests
 * under bare `node --test`, like gate-parse.mjs / gate-result.mjs.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { planParkAsk } from "./gate-ask.mjs"
import { dialectFor, hostFor } from "./src/dialect.mjs"
import { exitAfterWrite } from "./src/emit.mjs"
import { failOpen } from "./src/crash.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const passThrough = () => process.exit(0)

/**
 * Every text payload an MCP tool result might arrive as, flattened.
 *
 * The envelope is not one fixed shape across host versions: the result reaches a
 * hook as the `{content: [...]}` object the server returned, as the bare content
 * array, or as the already-extracted text. Accepting the known spellings is the
 * same defence gate-command.mjs applies to `prompt`/`user_input`/`userInput`, and
 * anything unrecognized simply yields nothing to parse.
 */
const resultTexts = (value, depth = 0) => {
  if (depth > 2) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((part) => resultTexts(part?.text, depth + 1))
  if (value && typeof value === "object") return resultTexts(value.content, depth + 1)
  return []
}

/** The `{gate, id}` of an object that already carries a plan-gate descriptor, or null. */
const planGateIn = (value) => {
  const gate = value && typeof value === "object" ? value.gate : undefined
  if (!gate || typeof gate !== "object") return null
  if (gate.kind !== "plan" || typeof gate.id !== "string" || !gate.id) return null
  return gate.id
}

/**
 * The task id whose plan just parked, or null when this result is not a park.
 *
 * Checks the structured value first (a host that hands the hook the parsed
 * payload), then each text part parsed as JSON — which is what `ok()` writes.
 * Pure; exported for the tests.
 */
export const planGateOf = (toolResponse) => {
  const direct = planGateIn(toolResponse)
  if (direct) return direct
  for (const text of resultTexts(toolResponse)) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      continue // not our JSON payload — some hosts include plain-text parts
    }
    const id = planGateIn(parsed)
    if (id) return id
  }
  return null
}

const main = async () => {
  let input = {}
  try {
    input = JSON.parse(await read())
  } catch {
    return passThrough()
  }
  // Field name varies across host versions — accept the known spellings, exactly
  // as gate-command.mjs does for the prompt.
  const response = input.tool_response ?? input.toolResponse ?? input.tool_result ?? input.toolResult
  if (response === undefined) return passThrough()
  const id = planGateOf(response)
  if (!id) return passThrough()
  const ask = planParkAsk(id, dialectFor(hostFor())?.askTool)
  if (!ask) return passThrough()
  // Exit in the write callback (src/emit.mjs): an early exit truncates the JSON
  // and the host silently drops the whole envelope.
  exitAfterWrite(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ask } }), 0)
}

// Run only when the host EXECUTES this file. Unlike the other hooks, this one is
// also imported — the parsing half is pure and worth pinning directly — and an
// unguarded `main()` would sit reading a test runner's stdin forever.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(failOpen("plan-gate-ask"))
