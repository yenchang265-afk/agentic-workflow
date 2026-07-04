#!/usr/bin/env node
/**
 * SessionStart reconciliation for the agentic-loop plugin. Surfaces loops that
 * died mid-run so the human knows to resume them — porting the OpenCode plugin's
 * startup reconciliation. Read-only: it only prints context, never mutates.
 *
 * Emits additionalContext via the SessionStart hook JSON output.
 */
import fs from "node:fs"
import path from "node:path"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const main = async () => {
  let input = {}
  try {
    input = JSON.parse(await read())
  } catch {
    /* ignore */
  }
  const cwd = input.cwd || process.cwd()
  let tasksDir = "docs/tasks"
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-loop.json"), "utf8"))
    if (typeof cfg.tasksDir === "string" && cfg.tasksDir) tasksDir = cfg.tasksDir
  } catch {
    /* default */
  }

  const notes = []
  const inProgress = path.join(cwd, tasksDir, "in-progress")
  try {
    for (const name of fs.readdirSync(inProgress)) {
      if (!name.endsWith(".md")) continue
      const body = fs.readFileSync(path.join(inProgress, name), "utf8")
      const lastStart = body.lastIndexOf("> BUILD started")
      const lastFinish = body.lastIndexOf("> BUILD finished")
      if (lastStart !== -1 && lastFinish < lastStart) notes.push(name.replace(/\.md$/, ""))
    }
  } catch {
    /* no folder */
  }
  let snapshots = []
  try {
    snapshots = fs
      .readdirSync(path.join(cwd, tasksDir, "runs"))
      .filter((n) => n.endsWith(".state.json"))
      .map((n) => n.replace(/\.state\.json$/, ""))
  } catch {
    /* none */
  }

  const lines = []
  if (notes.length) lines.push(`agentic-loop: interrupted task(s) in ${tasksDir}/in-progress: ${notes.join(", ")} — run \`/agent-loop recover <id>\` to resume.`)
  if (snapshots.length) lines.push(`agentic-loop: loop state snapshot(s) present: ${snapshots.join(", ")} — \`/agent-loop recover <id>\` resumes at the exact stage.`)
  if (!lines.length) return process.exit(0)

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }),
  )
  process.exit(0)
}

main()
