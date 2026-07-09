#!/usr/bin/env node
/**
 * UserPromptSubmit hook for the agentic-loop plugin. Makes the gate commands
 * `/agent-loop-task approve|approve-plan|replan <id> [reason]` move the task file
 * DETERMINISTICALLY — in the harness, before the model runs — so the move happens
 * even when a degraded model would not call the equivalent MCP tool.
 *
 * On a gate command it shells to `node mcp-server/dist/server.js gate <verb> <id>`
 * (the same core move logic the MCP tools call), then BLOCKS the turn so the model
 * never runs (no double-move). Anything else — including `new`/`retask`, which need
 * the model's interview — passes straight through untouched. If the CLI can't run
 * (dist missing, node error) it FAILS OPEN so the model + MCP-tool path still works.
 */
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

// Match either the raw command (`/agent-loop-task approve foo`) or the sentinel a
// command template may emit once expanded (`GATE-DISPATCH: approve foo`) — covers
// both possible UserPromptSubmit interception points (pre- or post-expansion).
// Longest alternative first — ordered alternation, so `approve-plan` is tried
// before `approve` (otherwise `approve` matches and `-plan` leaks into the id).
const VERB = "(approve-plan|replan|approve)"
const RAW = new RegExp(`(?:^|\\s|/)agent-loop-task\\s+${VERB}\\b[ \\t]*(\\S+)?[ \\t]*(.*)$`, "im")
const SENTINEL = new RegExp(`GATE-DISPATCH:\\s*${VERB}\\b[ \\t]*(\\S+)?[ \\t]*(.*)$`, "im")

// The folder-driven shortcuts `/agent-loop approve [id]` and `/agent-loop reject
// [id] [reason]` — subcommands of /agent-loop, NOT top-level words (so they never
// collide with a reserved `/approve`). Unlike the verbs above they need NO id — a
// bare `/agent-loop approve` auto-resolves the single awaiting task. `agent-loop\s+`
// cannot match `agent-loop-task approve` (a hyphen, not whitespace, follows), and
// the legacy `agent-loop-task` RAW is tried first anyway.
const APPROVE = /(?:^|\s|\/)agent-loop\s+approve\b[ \t]*(.*)$/im
const REJECT = /(?:^|\s|\/)agent-loop\s+reject\b[ \t]*(.*)$/im

const passThrough = () => process.exit(0)

/**
 * Build the `gate` CLI argv from the prompt, or null when it is not a gate
 * command. Legacy `agent-loop-task` verbs require an id (a bare one is malformed
 * — passed through so the model reports usage); the shortcuts do not.
 */
const gateArgsFor = (prompt) => {
  const legacy = prompt.match(SENTINEL) || prompt.match(RAW)
  if (legacy) {
    const id = (legacy[2] || "").trim()
    if (!id) return { passThrough: true } // malformed legacy gate — let the model report it
    const reason = (legacy[3] || "").trim()
    return { argv: ["gate", legacy[1], id, ...(reason ? [reason] : [])] }
  }
  const approve = prompt.match(APPROVE)
  if (approve) {
    // approve takes an optional id (first token); extra words are ignored.
    const id = (approve[1] || "").trim().split(/\s+/).filter(Boolean)[0] || ""
    return { argv: ["gate", "approve-any", ...(id ? [id] : [])] }
  }
  const reject = prompt.match(REJECT)
  if (reject) {
    const words = (reject[1] || "").trim().split(/\s+/).filter(Boolean)
    return { argv: ["gate", "reject-any", ...words] }
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
  // Field name varies across Claude Code versions — accept the known spellings.
  const prompt = input.prompt ?? input.user_input ?? input.userInput ?? ""
  const cwd = input.cwd || process.cwd()
  if (typeof prompt !== "string" || !prompt) return passThrough()

  const dispatch = gateArgsFor(prompt)
  if (!dispatch) return passThrough() // not a gate command (new/retask/anything else) — let the model handle it
  if (dispatch.passThrough) return passThrough() // malformed — let the model report the usage error
  const args = dispatch.argv

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const serverJs = path.join(pluginRoot, "mcp-server", "dist", "server.js")
  const res = spawnSync("node", [serverJs, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AGENTIC_LOOP_DIR: process.env.AGENTIC_LOOP_DIR ?? cwd },
  })

  // Could not run the CLI (dist not built, node missing, crash) — FAIL OPEN.
  if (res.error || res.status === null || res.status === undefined) return passThrough()

  // Parse the GateResult JSON line the CLI prints (last non-empty stdout line).
  let result = { ok: res.status === 0, message: (res.stdout || "").trim() }
  try {
    const last = (res.stdout || "").trim().split("\n").filter(Boolean).pop()
    const parsed = last ? JSON.parse(last) : null
    if (parsed && typeof parsed.message === "string") result = parsed
  } catch {
    /* keep the raw fallback */
  }
  const label = args.slice(1).join(" ")
  const message = result.message || (result.ok ? `Gate ${label} done.` : `Gate ${label} failed — see the backlog.`)

  // The move already happened deterministically. BLOCK the turn so the model does
  // not also run (and cannot double-move); the reason is shown to the user.
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: message,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message },
    }),
  )
  process.exit(0)
}

main()
