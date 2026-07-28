/**
 * Recording what a check stage actually DID, for the verdict's proof-of-work
 * gate (`@agentic-workflow/core/workflow/evidence`).
 *
 * The gate needs one thing the agent cannot supply: an account of the stage's
 * tool calls written by something other than the agent. On this host the
 * PreToolUse guard is the only component that sees every call, and it runs as a
 * separate process per call — so the account is a file under `<tasksDir>/runs/`
 * that the guard appends to and the MCP server reads back when
 * `workflow_verdict` arrives.
 *
 * Recorded at the point the guard has decided to ALLOW the call: a command that
 * the allowlist refused never ran, and counting it would let a stage manufacture
 * evidence out of blocked commands.
 *
 * Best-effort throughout. An unwritable runs/ dir degrades the gate to the
 * declared-evidence rule alone (the server reads null and says so) — it must
 * never block a tool call, because a guard that fails a stage over its own
 * bookkeeping is worse than a weaker gate.
 *
 * Dependency-free beyond node built-ins so it bundles into the hook, matching
 * ./marker.mjs.
 */
import fs from "node:fs"
import path from "node:path"
import { isBashTool, isReadTool } from "./dialect.mjs"

/**
 * Most entries kept per channel. The cap keeps a long stage from growing the
 * file without bound; entries past it are DROPPED rather than rotated, so a
 * stage cannot flush an inconvenient early command out of the record by running
 * a few hundred harmless ones.
 */
export const EVIDENCE_MAX = 200

/** The read tools' path argument, in probe order — union of both hosts' spellings. */
const READ_PATH_KEYS = ["file_path", "absolute_path", "path", "notebook_path", "paths"]

/**
 * What this tool call contributes to the ledger: `{ commands }`, `{ reads }`, or
 * null for a call that is neither (a write, a spawn, an MCP tool).
 *
 * `command` is the EFFECTIVE command — the worktree pin may have rewritten it —
 * because that is what will actually run, and the declared/observed match is
 * containment-based either way. Pure.
 */
export const evidenceEntry = (d, tool, toolInput, command) => {
  const ti = toolInput || {}
  if (isBashTool(d, tool)) {
    const cmd = String(command ?? ti.command ?? "").trim()
    return cmd ? { commands: [cmd], reads: [] } : null
  }
  if (!isReadTool(d, tool)) return null
  const reads = []
  for (const key of READ_PATH_KEYS) {
    const value = ti[key]
    if (typeof value === "string" && value.trim()) reads.push(value.trim())
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && v.trim()) reads.push(v.trim())
  }
  return reads.length ? { commands: [], reads } : null
}

/** An empty ledger for `stage`. Pure. */
const emptyLedger = (stage) => ({ stage: stage ?? null, commands: [], reads: [] })

/**
 * Fold an entry into a ledger, honoring the cap and de-duping. A stage that
 * re-reads the same file thirty times has observed one file. Pure.
 */
export const withEntry = (ledger, entry) => {
  const add = (list, incoming) => {
    const out = list.slice()
    for (const value of incoming) {
      if (out.length >= EVIDENCE_MAX) break
      if (!out.includes(value)) out.push(value)
    }
    return out
  }
  return {
    stage: ledger.stage,
    commands: add(ledger.commands, entry.commands),
    reads: add(ledger.reads, entry.reads),
  }
}

/** Parse a ledger blob, or null when it is absent/unusable. Pure. */
export const parseLedger = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])
    return { stage: typeof parsed.stage === "string" ? parsed.stage : null, commands: list(parsed.commands), reads: list(parsed.reads) }
  } catch {
    return null
  }
}

/**
 * Append this tool call's contribution to the stage's ledger. Never throws:
 * every failure path leaves the ledger as it was and the gate degrades.
 */
export const noteEvidence = (runsDirPath, evidenceFile, stage, entry) => {
  if (!entry) return
  const file = path.join(runsDirPath, evidenceFile)
  try {
    const existing = fs.existsSync(file) ? parseLedger(fs.readFileSync(file, "utf8")) : null
    // A ledger left over from a previous stage is not this stage's evidence.
    const base = existing && existing.stage === stage ? existing : emptyLedger(stage)
    fs.writeFileSync(file, JSON.stringify(withEntry(base, entry)))
  } catch {
    /* best-effort — bookkeeping must never fail a tool call */
  }
}
