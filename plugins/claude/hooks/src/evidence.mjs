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

/**
 * Byte cap past which appends stop, mirroring the deny log's
 * `DENY_LOG_MAX_BYTES`. `EVIDENCE_MAX` caps only the FOLD — the file itself is
 * append-only NDJSON with no read-modify-write, so without this a long stage
 * (or a stale marker collecting every later session's reads) grows it without
 * bound. Stopping rather than rotating keeps the "cannot flush an early command
 * out of the record" property: entries past the cap are dropped, never the ones
 * already written.
 */
export const EVIDENCE_MAX_BYTES = 1024 * 1024

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

/** Parse one ledger line (or the legacy whole-file blob — same shape), or null. Pure. */
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
 * Fold the ledger file's NDJSON lines into one per-stage ledger, or null when
 * no line belongs to `stage` (null means "this host did not observe" — the gate
 * degrades to the declared-evidence rule; an EMPTY set would reject a PASS).
 *
 * Lines from another stage are skipped, an unparseable line is skipped (a torn
 * concurrent append costs one entry, never the file), and the legacy single-blob
 * format folds for free — it is one JSON line of the exact same shape. The
 * `EVIDENCE_MAX` cap applies at fold in first-seen order, preserving the
 * "cannot flush an early command out of the record" property. Pure.
 */
export const foldLedger = (raw, stage) => {
  let ledger = null
  for (const line of String(raw ?? "").split("\n")) {
    const t = line.trim()
    if (!t) continue
    const parsed = parseLedger(t)
    if (!parsed || parsed.stage !== stage) continue
    ledger = withEntry(ledger ?? emptyLedger(stage), parsed)
  }
  return ledger
}

/**
 * Append this tool call's contribution to the stage's ledger as one NDJSON
 * line. APPEND-ONLY by design: the guard runs as a separate process per tool
 * call, and several hook processes fire concurrently when one assistant message
 * carries several tool_use blocks — the previous read-modify-write ledger lost
 * every concurrent write but the last, and the missing reads then made
 * `evidenceIssue` reject an honest PASS. An O_APPEND write per call has no
 * read-modify-write to race; folding happens at read (`foldLedger`).
 *
 * Never throws: every failure path leaves the ledger as it was and the gate
 * degrades.
 */
export const noteEvidence = (runsDirPath, evidenceFile, stage, entry) => {
  if (!entry) return
  const file = path.join(runsDirPath, evidenceFile)
  try {
    try {
      if (fs.statSync(file).size > EVIDENCE_MAX_BYTES) return
    } catch {
      /* no file yet — the first append creates it */
    }
    // LEADING newline, not trailing: a legacy single-blob file has no trailing
    // newline, and appending bare JSON right after it would merge both into one
    // unparseable line. A leading separator keeps every record on its own line
    // whatever wrote before; blank lines are filtered at fold.
    fs.appendFileSync(file, "\n" + JSON.stringify({ stage: stage ?? null, commands: entry.commands, reads: entry.reads }) + "\n")
  } catch {
    /* best-effort — bookkeeping must never fail a tool call */
  }
}
