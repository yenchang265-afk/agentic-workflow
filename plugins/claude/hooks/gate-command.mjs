#!/usr/bin/env node
/**
 * UserPromptSubmit hook for the agentic-workflow plugin. Makes the gate verbs
 * `/agentic-workflow:engineering approve|replan [id] [reason]` move the task file
 * DETERMINISTICALLY — in the harness, before the model runs — so the move
 * happens even when a degraded model would not call the equivalent MCP tool.
 *
 * On a gate command it shells to `node mcp-server/dist/server.js gate <verb> <id>`
 * (the same core move logic the MCP tools call), then BLOCKS the turn so the model
 * never runs (no double-move).
 *
 * Anything else — including `new`, which needs the model's interview — runs, and
 * gets the invoked verb's procedure injected as context (verb-slice.mjs). The
 * command body is only a router on this host, because a UserPromptSubmit hook
 * cannot rewrite the prompt it sees. Prompts that are not the engineering
 * command pass straight through untouched: this hook's matcher is `""`.
 *
 * `retask` is the hybrid: its move IS deterministic, but the reshape after it is
 * an interview. It dispatches like a gate verb and then, on success, hands the
 * turn back with the outcome as context (`continueTurn`); a refusal still blocks.
 *
 * `approve` is the CONDITIONAL hybrid (`continueOnGate`). It is folder-driven, so
 * only the result says which gate it crossed: after the TASK gate the turn is
 * handed back with an injected follow-up (gate-ask.mjs) so the model can ask
 * whether to plan the task now — a blocked turn can never ask anything, which is
 * why that question simply did not exist on this path. The terminal ship gate and
 * every refusal still block.
 *
 * Failure handling (decideGateOutcome in gate-result.mjs, pure + unit-tested):
 * - dist/server.js missing → BLOCK with the "not built — run the installer"
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
import { gateAmbiguityAsk, gateAsk } from "./gate-ask.mjs"
import { gateArgsFor, verbFor } from "./gate-parse.mjs"
import { decideGateOutcome } from "./gate-result.mjs"
import { dialectFor, hostFor } from "./src/dialect.mjs"
import { exitAfterWrite } from "./src/emit.mjs"
import { verbContext } from "./verb-slice.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const passThrough = () => process.exit(0)

/**
 * Let the turn run, but hand the model what the deterministic half just did.
 * Used by the hybrid verbs (`continueTurn`): blocking would kill the interview
 * they still need, but staying silent would leave the model guessing where the
 * task now sits.
 */
const augment = (message) => {
  // Exit in the write callback (src/emit.mjs): an early exit truncates the
  // JSON and the host silently drops the whole envelope.
  exitAfterWrite(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message } }), 0)
}

const block = (message) => {
  // A truncated envelope loses `decision: "block"` — the model then runs the
  // gate verb AFTER the CLI already moved the task, the double-move this
  // block exists to prevent. Exit only once the payload is flushed.
  exitAfterWrite(
    process.stdout,
    JSON.stringify({
      decision: "block",
      reason: message,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message },
    }),
    0,
  )
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

  // AGENTIC_WORKFLOW_PLUGIN_ROOT first: hosts other than Claude Code have no
  // CLAUDE_PLUGIN_ROOT, and their installer supplies this instead.
  const pluginRoot =
    process.env.AGENTIC_WORKFLOW_PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

  // The engineering command body is a router; the invoked verb's procedure lives
  // in verbs/engineering.md and is injected here (see verb-slice.mjs for why the
  // model cannot just read it). Non-engineering prompts get nothing — this hook
  // has matcher "" and sees every prompt in the session.
  const injectVerb = () => {
    const context = verbContext(pluginRoot, verbFor(prompt))
    return context ? augment(context) : passThrough()
  }

  const dispatch = gateArgsFor(prompt)
  if (!dispatch) return injectVerb() // not a gate command (new/plan/claim/status/…) — the model does the work
  // An id-less gate verb is a deterministic usage refusal: block with the
  // message directly — spending a model turn to restate usage is waste, and
  // matches the OpenCode host, whose driver answers these arms itself.
  if (dispatch.usage) return block(dispatch.usage)
  const args = dispatch.argv
  const label = args.slice(1).join(" ")

  // AGENTIC_WORKFLOW_SERVER_JS first: on hosts that REUSE this plugin's built
  // server (Qwen installs `plugins/qwen` as its plugin root but runs
  // `plugins/claude/mcp-server/dist/server.js`), the server does not live under
  // the plugin root at all. Deriving it from the root alone made `distExists`
  // permanently false there, so every gate verb blocked with "not built" and
  // re-running the installer could never fix it.
  const serverJs = process.env.AGENTIC_WORKFLOW_SERVER_JS || path.join(pluginRoot, "mcp-server", "dist", "server.js")

  const distExists = fs.existsSync(serverJs)
  const res = distExists
    ? spawnSync("node", [serverJs, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, AGENTIC_WORKFLOW_DIR: process.env.AGENTIC_WORKFLOW_DIR ?? cwd },
      })
    : {}

  const outcome = decideGateOutcome(
    { distExists, spawnError: res.error, status: res.status, stdout: res.stdout },
    label,
    dialectFor(hostFor())?.installer,
  )
  // Fail-open: the CLI crashed without a verdict, so the model runs the verb via
  // its MCP fallback — which is described in the verb's own block, not the router.
  if (outcome.action === "pass") return injectVerb()

  const message = outcome.message || `Gate ${label} ${outcome.ok ? "done" : "failed — see the backlog"}.`

  // A hybrid verb (retask) did only its deterministic half here. On success the
  // model must still run — hand it the outcome as context rather than blocking.
  // A refusal still blocks: there is nothing left for the model to do, and
  // letting it proceed is exactly how a second copy of a live task's id gets
  // authored into draft/.
  if (dispatch.continueTurn && outcome.ok) {
    const context = verbContext(pluginRoot, verbFor(prompt))
    return augment(context ? `${message}\n\n${context}` : message)
  }

  // The CONDITIONAL hybrid (approve), in two arms. Which gate a folder-driven
  // verb crossed is only knowable from the result, so the continue decision is
  // made here rather than in the parser: a task gate hands the turn back so the
  // model can ask "plan it now?" — a question a blocked turn could never reach —
  // while the terminal ship gate still blocks, exactly as before. The second arm
  // does the same for the id-less ambiguity, which is a refusal but not a move
  // (see below).
  //
  // Every uncertainty falls through to the block below: an unrecognized gate, a
  // missing id, an unusable candidate list, an older mcp-server/dist that emits
  // no `data` at all. That is deliberate — a false block only restores the
  // previous behaviour, whereas handing the turn back on a gate nobody armed
  // invites the double-move the block exists to prevent.
  const ask = outcome.ok
    ? dispatch.continueOnGate?.includes(outcome.data?.gate)
      ? gateAsk(outcome.data.gate, outcome.data.id, dialectFor(hostFor())?.askTool, outcome.data)
      : null
    : // The one arm that continues on a REFUSAL, and it is sound for a reason no
      // other refusal shares: NOTHING MOVED. An id-less approve that found
      // several candidates never reached a move — `resolveGateTask` only lists —
      // so the double-move this hook blocks to prevent cannot exist here, and the
      // follow-up asks for a FIRST approve on an id the human picks. Keep it
      // pinned to the verbs the parser declared: a blanket "continue on refusal"
      // would hand the turn back on wrong-folder and not-found too, where there
      // is nothing to choose between and nothing to say.
      dispatch.continueOnAmbiguity?.includes(args[1])
      ? gateAmbiguityAsk(outcome.data?.candidates, dialectFor(hostFor())?.askTool)
      : null
  if (ask) {
    const context = verbContext(pluginRoot, verbFor(prompt))
    // The ask goes LAST: it is the instruction for this turn, and the verb block
    // it follows still describes `approve` as a verb the model normally never sees.
    return augment([message, context, ask].filter(Boolean).join("\n\n"))
  }

  // Either the move already happened deterministically (block with its
  // verdict so the model cannot double-move), or the plugin isn't built
  // (block with the diagnosis so the model cannot fabricate a gate).
  return block(message)
}

main()
