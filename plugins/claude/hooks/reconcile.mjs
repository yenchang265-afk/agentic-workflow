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
      // Inline re-implementation of store.ts's `wasInterrupted` (a .mjs hook
      // can't import the TS lib without depending on dist/) — keep in sync.
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
  // A claim marker in queued/.claims/ with no live loop means a run died
  // mid-PLAN — it blocks every future claim of that task until removed.
  let planClaims = []
  try {
    planClaims = fs.readdirSync(path.join(cwd, tasksDir, "queued", ".claims"))
  } catch {
    /* none */
  }

  // Backlog anomaly sweep — inline re-implementation of core's
  // task/audit.ts `auditBacklog` (a .mjs hook can't import the TS lib
  // without depending on dist/) — keep in sync.
  const STATUSES = ["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"]
  const unknownDirs = []
  const strayFiles = []
  const idsSeen = new Map()
  try {
    const root = path.join(cwd, tasksDir)
    for (const name of fs.readdirSync(root)) {
      const stat = fs.statSync(path.join(root, name))
      if (stat.isDirectory()) {
        if (name.startsWith(".") || name === "runs" || STATUSES.includes(name)) continue
        unknownDirs.push(name)
        for (const f of fs.readdirSync(path.join(root, name))) {
          if (f.endsWith(".md")) strayFiles.push(`${tasksDir}/${name}/${f}`)
        }
      } else if (name.endsWith(".md")) {
        strayFiles.push(`${tasksDir}/${name}`)
      }
    }
    for (const status of STATUSES) {
      let entries = []
      try {
        entries = fs.readdirSync(path.join(root, status))
      } catch {
        continue
      }
      for (const f of entries) {
        if (!f.endsWith(".md")) continue
        const id = f.replace(/\.md$/, "")
        idsSeen.set(id, [...(idsSeen.get(id) ?? []), status])
      }
    }
  } catch {
    /* no backlog */
  }
  const duplicates = [...idsSeen.entries()].filter(([, statuses]) => statuses.length > 1)

  const lines = []
  if (notes.length) lines.push(`agentic-loop: interrupted task(s) in ${tasksDir}/in-progress: ${notes.join(", ")} — run \`/agentic-loop:engineering recover <id>\` to resume.`)
  if (snapshots.length) lines.push(`agentic-loop: loop state snapshot(s) present: ${snapshots.join(", ")} — \`/agentic-loop:engineering recover <id>\` resumes at the exact stage.`)
  if (planClaims.length) lines.push(`agentic-loop: leftover plan-claim marker(s) in ${tasksDir}/queued/.claims: ${planClaims.join(", ")} — a prior run died mid-PLAN; \`loop_doctor\` (fix:true) releases stale markers so the task can be claimed again.`)
  if (unknownDirs.length) lines.push(`agentic-loop: unknown folder(s) under ${tasksDir}: ${unknownDirs.join(", ")} — not status folders; \`loop_doctor\` reports and repairs.`)
  if (strayFiles.length) lines.push(`agentic-loop: stray task file(s) outside every status folder: ${strayFiles.join(", ")} — invisible to the loop; \`loop_doctor\` (fix:true) rescues them to draft/.`)
  if (duplicates.length) lines.push(`agentic-loop: duplicate task id(s) across status folders: ${duplicates.map(([id, s]) => `${id} (${s.join(", ")})`).join("; ")} — resolve manually (keep one, loop_move the rest to abandoned).`)
  if (!lines.length) return process.exit(0)

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }),
  )
  process.exit(0)
}

main()
