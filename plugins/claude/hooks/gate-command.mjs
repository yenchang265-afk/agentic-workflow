#!/usr/bin/env node
/**
 * UserPromptSubmit hook for the agentic-loop plugin. Makes the gate verbs
 * `/agentic-loop:engineering approve|replan [id] [reason]` move the task file
 * DETERMINISTICALLY — in the harness, before the model runs — so the move
 * happens even when a degraded model would not call the equivalent MCP tool.
 *
 * On a gate command it shells to `node mcp-server/dist/server.js gate <verb> <id>`
 * (the same core move logic the MCP tools call), then BLOCKS the turn so the model
 * never runs (no double-move). Anything else — including `new`/`retask`, which need
 * the model's interview — passes straight through untouched.
 *
 * Failure handling (decideGateOutcome in gate-result.mjs, pure + unit-tested):
 * - dist/server.js missing → BLOCK with the "not built — run install.sh"
 *   diagnosis. Failing open would be pointless: the MCP fallback launches the
 *   same missing dist, so the model could only flounder or fabricate a move.
 * - the CLI ran and printed a GateResult → BLOCK with that verdict;
 * - the CLI crashed without a GateResult (node/spawn error, half-built dist)
 *   → FAIL OPEN so the model + MCP-tool path still works.
 *
 * Prompt→argv parsing lives in gate-parse.mjs (pure, unit-tested).
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gateArgsFor } from "./gate-parse.mjs"
import { decideGateOutcome } from "./gate-result.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const passThrough = () => process.exit(0)

const block = (message) => {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: message,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message },
    }),
  )
  process.exit(0)
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
  const label = args.slice(1).join(" ")

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const serverJs = path.join(pluginRoot, "mcp-server", "dist", "server.js")

  const distExists = fs.existsSync(serverJs)
  const res = distExists
    ? spawnSync("node", [serverJs, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, AGENTIC_LOOP_DIR: process.env.AGENTIC_LOOP_DIR ?? cwd },
      })
    : {}

  const outcome = decideGateOutcome(
    { distExists, spawnError: res.error, status: res.status, stdout: res.stdout },
    label,
  )
  if (outcome.action === "pass") return passThrough()

  // Either the move already happened deterministically (block with its
  // verdict so the model cannot double-move), or the plugin isn't built
  // (block with the diagnosis so the model cannot fabricate a gate).
  return block(outcome.message || `Gate ${label} ${outcome.ok ? "done" : "failed — see the backlog"}.`)
}

main()
