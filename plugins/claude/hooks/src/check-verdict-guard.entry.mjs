#!/usr/bin/env node
/**
 * SOURCE of the SubagentStop verdict guard. `npm run build:hooks`
 * (scripts/build-hooks.mjs) bundles this into ../check-verdict-guard.mjs;
 * never edit the bundled output by hand.
 *
 * When a check-stage subagent (VERIFY/REVIEW/…) stops without having called
 * the `loop_verdict` MCP tool, block the stop once with a reminder (exit 2 —
 * stderr goes back to the subagent). The `.verdict-nag` sentinel makes the
 * block one-shot per stage attempt: a subagent whose tool is genuinely
 * unreachable is never trapped, and the MCP server's no-verdict retry
 * (loop_advance) handles the miss from there. The MCP server clears the
 * sentinel on every stage (re-)arm and when a verdict lands.
 *
 * Contract: exit 0 allows the stop; exit 2 blocks it and feeds stderr back.
 */
import fs from "node:fs"
import path from "node:path"
import { decideVerdictGuard, nagMessage } from "./verdict-guard.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const allow = () => process.exit(0)
const block = (reason) => {
  process.stderr.write(reason + "\n")
  process.exit(2)
}

// tasksDir defaults to docs/tasks; honor .agentic-loop.json if present.
const readTasksDir = (cwd) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-loop.json"), "utf8"))
    if (typeof cfg.tasksDir === "string" && cfg.tasksDir) return cfg.tasksDir
  } catch {
    /* default */
  }
  return "docs/tasks"
}

const main = async () => {
  let input
  try {
    input = JSON.parse(await read())
  } catch {
    return allow()
  }
  const cwd = input.cwd || process.cwd()
  const tasksDir = readTasksDir(cwd)
  const runsDir = path.join(cwd, tasksDir, "runs")
  let marker = null
  try {
    marker = JSON.parse(fs.readFileSync(path.join(runsDir, ".stage.json"), "utf8"))
  } catch {
    return allow()
  }
  const nagPath = path.join(runsDir, ".verdict-nag")
  const decision = decideVerdictGuard(marker, fs.existsSync(nagPath))
  if (decision !== "nag") return allow()
  try {
    fs.writeFileSync(nagPath, String(marker.stage ?? ""))
  } catch {
    return allow() // can't make the block one-shot — fail open rather than trap the subagent
  }
  return block(nagMessage(marker.stage))
}

main()
