#!/usr/bin/env node
/**
 * SOURCE of the SubagentStop verdict guard. `npm run build:hooks`
 * (scripts/build-hooks.mjs) bundles this into ../check-verdict-guard.mjs;
 * never edit the bundled output by hand.
 *
 * When a check-stage subagent (VERIFY/REVIEW/…) stops without having called
 * the `workflow_verdict` MCP tool, block the stop once with a reminder (exit 2 —
 * stderr goes back to the subagent). The `.verdict-nag` sentinel makes the
 * block one-shot per stage attempt: a subagent whose tool is genuinely
 * unreachable is never trapped, and the MCP server's no-verdict retry
 * (workflow_advance) handles the miss from there. The MCP server clears the
 * sentinel on every stage (re-)arm and when a verdict lands.
 *
 * Contract: exit 0 allows the stop; exit 2 blocks it and feeds stderr back.
 */
import fs from "node:fs"
import path from "node:path"
import { dialectFor, hostFor } from "./dialect.mjs"
import { exitAfterWrite } from "./emit.mjs"
import { runsDir } from "./marker.mjs"
import { decideVerdictGuard, nagMessage } from "./verdict-guard.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const allow = () => process.exit(0)
const block = (reason) => {
  // Exit in the write callback (emit.mjs): the exit code blocks either way,
  // but an early exit truncates the reason the model is meant to read.
  exitAfterWrite(process.stderr, reason + "\n", 2)
}

const main = async () => {
  let input
  try {
    input = JSON.parse(await read())
  } catch {
    return allow()
  }
  const cwd = input.cwd || process.cwd()
  // Same resolution the MCP server uses to WRITE the marker — see marker.mjs.
  const runs = runsDir(cwd)
  // An unknown host cannot be nagged usefully — there is no marker path to read.
  // Unlike the PreToolUse guard, failing open here only skips a reminder.
  const d = dialectFor(hostFor())
  if (!d) return allow()
  let marker = null
  try {
    marker = JSON.parse(fs.readFileSync(path.join(runs, d.stageMarkerFile), "utf8"))
  } catch {
    return allow()
  }
  const nagPath = path.join(runs, d.verdictNagFile)
  const decision = decideVerdictGuard(marker, fs.existsSync(nagPath))
  if (decision !== "nag") return allow()
  try {
    fs.writeFileSync(nagPath, String(marker.stage ?? ""))
  } catch {
    return allow() // can't make the block one-shot — fail open rather than trap the subagent
  }
  return block(nagMessage(marker.stage, d.verdictAliases))
}

main()
