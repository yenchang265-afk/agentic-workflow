#!/usr/bin/env node
/**
 * SOURCE of the SessionStart reconciliation hook. `npm run build:hooks`
 * (scripts/build-hooks.mjs) esbuild-bundles this file — inlining the
 * @agentic-workflow/core interruption + audit logic — into the self-contained
 * ../reconcile.mjs that hooks.json runs (hooks execute under bare `node` from a
 * possibly-copied plugin dir with no node_modules). Never edit the bundled output
 * by hand; edit this file and rebuild.
 *
 * Surfaces loops that died mid-run so the human knows to resume them — the Claude
 * mirror of the OpenCode plugin's startup reconciliation (src/index.ts
 * `reconcileOnce`). Read-only: it only prints additionalContext, never mutates.
 *
 * The backlog anomaly sweep (`auditBacklog`/`formatAnomalies`) is imported from
 * core rather than re-implemented — one source of truth, bundled by esbuild. The
 * interruption test stays a tiny local mirror of core's `wasInterrupted`
 * (store.ts): importing it would drag the whole task store — and its `yaml`
 * dependency — into this bundle for two `lastIndexOf` calls.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { auditBacklog, formatAnomalies, hasAnomalies } from "@agentic-workflow/core/task/audit"

/**
 * Mirror of core `wasInterrupted` (store.ts): a BUILD started with no later
 * finish, read only within the current lifecycle window (after the last
 * "> Plan approved" note) — an older attempt's unmatched note must not keep
 * flagging a re-planned, freshly approved task.
 */
const wasInterrupted = (body) => {
  const anchor = body.lastIndexOf("> Plan approved")
  const window = anchor === -1 ? body : body.slice(anchor)
  const lastStart = window.lastIndexOf("> BUILD started")
  if (lastStart === -1) return false
  return window.lastIndexOf("> BUILD finished") < lastStart
}

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

/**
 * A minimal core `Client` over node fs — enough for `auditBacklog`, which only
 * calls `file.list`. Mirrors the shape of the MCP server's fsClient shim.
 */
const fsClient = {
  file: {
    list: async ({ query: { path: rel, directory } }) => {
      try {
        const entries = fs.readdirSync(path.join(directory, rel), { withFileTypes: true })
        return { data: entries.map((e) => ({ type: e.isDirectory() ? "directory" : "file", name: e.name })) }
      } catch {
        return { data: [] }
      }
    },
    read: async () => ({ data: null }),
  },
  app: { log: async () => undefined },
}

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
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-workflow.json"), "utf8"))
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
      if (wasInterrupted(body)) notes.push(name.replace(/\.md$/, ""))
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

  const anomalies = await auditBacklog(fsClient, cwd, tasksDir)

  // The MCP server (and the deterministic gate CLI) live in mcp-server/dist —
  // never built means every gate verb and loop tool is dead. Surface it at
  // session start, before the first silently-failing approve.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const serverBuilt = fs.existsSync(path.join(pluginRoot, "mcp-server", "dist", "server.js"))

  const lines = []
  if (!serverBuilt) lines.push("agentic-workflow: MCP server not built (mcp-server/dist/server.js missing) — gates and loop tools will not work. Run plugins/claude/install.sh, then restart the session.")
  if (notes.length) lines.push(`agentic-workflow: interrupted task(s) in ${tasksDir}/in-progress: ${notes.join(", ")} — run \`/agentic-workflow:engineering recover <id>\` to resume.`)
  if (snapshots.length) lines.push(`agentic-workflow: loop state snapshot(s) present: ${snapshots.join(", ")} — \`/agentic-workflow:engineering recover <id>\` resumes at the exact stage.`)
  if (planClaims.length) lines.push(`agentic-workflow: leftover plan-claim marker(s) in ${tasksDir}/queued/.claims: ${planClaims.join(", ")} — a prior run died mid-PLAN; \`loop_doctor\` (fix:true) releases stale markers so the task can be claimed again.`)
  if (hasAnomalies(anomalies)) {
    for (const line of formatAnomalies(anomalies, tasksDir)) lines.push(`agentic-workflow: ${line} — \`loop_doctor\` reports and repairs.`)
  }
  if (!lines.length) return process.exit(0)

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }),
  )
  process.exit(0)
}

main()
