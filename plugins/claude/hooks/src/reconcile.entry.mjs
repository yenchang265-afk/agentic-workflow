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
import { dialectFor, hostFor } from "./dialect.mjs"
import { exitAfterWrite } from "./emit.mjs"
import { idList, MAX_LISTED } from "./idlist.mjs"
import { backlogRoot, readTasksDir } from "./marker.mjs"

/**
 * Mirror of core `wasInterrupted` (store.ts): a BUILD started with no later
 * finish, read only within the current lifecycle window (after the last
 * "> Plan approved" note) — an older attempt's unmatched note must not keep
 * flagging a re-planned, freshly approved task. Like core, markers count only
 * at line starts (audit notes are whole lines): a body QUOTING the literal
 * text mid-line must not read as lifecycle state. MUST stay behaviorally in
 * sync with store.ts `lastMarkerIndex`/`wasInterrupted`.
 */
const lastMarkerIndex = (body, marker) => {
  for (let idx = body.lastIndexOf(marker); idx !== -1; idx = body.lastIndexOf(marker, idx - 1)) {
    if (idx === 0 || body[idx - 1] === "\n") return idx
  }
  return -1
}

const wasInterrupted = (body) => {
  const anchor = lastMarkerIndex(body, "> Plan approved")
  const window = anchor === -1 ? body : body.slice(anchor)
  const lastStart = lastMarkerIndex(window, "> BUILD started")
  if (lastStart === -1) return false
  return lastMarkerIndex(window, "> BUILD finished") < lastStart
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
  // Resolved the way the MCP server resolves it when it writes there — env
  // root, repo layer over user layer. See marker.mjs.
  const root = backlogRoot(cwd)
  const tasksDir = readTasksDir(root)

  const notes = []
  const inProgress = path.join(root, tasksDir, "in-progress")
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
      .readdirSync(path.join(root, tasksDir, "runs"))
      .filter((n) => n.endsWith(".state.json"))
      .map((n) => n.replace(/\.state\.json$/, ""))
  } catch {
    /* none */
  }
  // A claim marker in queued/.claims/ with no live loop means a run died
  // mid-PLAN — it blocks every future claim of that task until removed.
  let planClaims = []
  try {
    planClaims = fs.readdirSync(path.join(root, tasksDir, "queued", ".claims")).filter((n) => !n.startsWith("."))
  } catch {
    /* none */
  }

  const anomalies = await auditBacklog(fsClient, root, tasksDir)

  // The MCP server (and the deterministic gate CLI) live in mcp-server/dist —
  // never built means every gate verb and loop tool is dead. Surface it at
  // session start, before the first silently-failing approve.
  const pluginRoot =
    process.env.AGENTIC_WORKFLOW_PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const serverBuilt = fs.existsSync(path.join(pluginRoot, "mcp-server", "dist", "server.js"))

  const lines = []
  if (!serverBuilt)
    lines.push(
      `agentic-workflow: MCP server not built (mcp-server/dist/server.js missing) — gates and loop tools will not work. Run ${dialectFor(hostFor())?.installer ?? "the installer"}, then restart the session.`,
    )
  // Every id below is a FILE NAME off the disk, and this text goes into the
  // model's context at SessionStart before the user types anything — so the
  // lists are sanitized and capped by `idList`, which states what it dropped.
  // `tasksDir` is repo-layer config — the same semi-untrusted rail — so control
  // characters in it are neutralized too rather than interpolated raw.
  // eslint-disable-next-line no-control-regex
  const dirShown = tasksDir.replace(/[\u0000-\u001f\u007f]/g, "�")
  const notesList = idList(notes)
  const snapshotsList = idList(snapshots)
  const claimsList = idList(planClaims)
  if (notesList) lines.push(`agentic-workflow: interrupted task(s) in ${dirShown}/in-progress: ${notesList} — run \`/agentic-workflow:engineering recover <id>\` to resume.`)
  if (snapshotsList) lines.push(`agentic-workflow: loop state snapshot(s) present: ${snapshotsList} — \`/agentic-workflow:engineering recover <id>\` resumes at the exact stage.`)
  if (claimsList) lines.push(`agentic-workflow: leftover plan-claim marker(s) in ${dirShown}/queued/.claims: ${claimsList} — a prior run died mid-PLAN; \`workflow_doctor\` (fix:true) releases stale markers so the task can be claimed again.`)
  if (hasAnomalies(anomalies)) {
    // Same cap as the id lists above: anomaly lines are also built from on-disk
    // names (formatAnomalies display-sanitizes each name), and a damaged backlog
    // can have hundreds of strays — dumping every one into every session is the
    // exact failure the id-list cap exists for. The overflow is stated, never
    // silently applied.
    const all = formatAnomalies(anomalies, tasksDir)
    for (const line of all.slice(0, MAX_LISTED)) lines.push(`agentic-workflow: ${line} — \`workflow_doctor\` reports and repairs.`)
    if (all.length > MAX_LISTED) lines.push(`agentic-workflow: +${all.length - MAX_LISTED} more backlog anomaly finding(s) — run \`workflow_doctor\` for the full report.`)
  }
  if (!lines.length) return process.exit(0)

  // Exit in the write callback (emit.mjs): an explicit `process.exit` right
  // after a large async-buffered write can truncate stdout mid-payload, and
  // Claude Code then drops the malformed JSON — and with it every warning
  // above — silently.
  exitAfterWrite(process.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }), 0)
}

main()
