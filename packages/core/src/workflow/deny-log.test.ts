import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  DENY_LOG_MAX,
  aggregateDenials,
  appendDenyEntry,
  clearDenyLog,
  denyLogPath,
  formatDenyFindings,
  parseDenyLine,
  readDenyLog,
  suggestFor,
} from "./deny-log.js"

const tmpRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deny-log-"))
  fs.mkdirSync(path.join(dir, "docs/tasks/runs"), { recursive: true })
  return dir
}

const entry = (command: string, stage = "verify", kind = "engineering") => ({
  ts: "2026-08-16T00:00:00.000Z",
  host: "claude",
  kind,
  stage,
  command,
})

test("append + read round-trips entries in order", () => {
  const dir = tmpRepo()
  appendDenyEntry(dir, "docs/tasks", entry("pnpm --filter web test"))
  appendDenyEntry(dir, "docs/tasks", entry("mvn clean test"))
  const read = readDenyLog(dir, "docs/tasks")
  assert.deepEqual(
    read.map((e) => e.command),
    ["pnpm --filter web test", "mvn clean test"],
  )
  assert.equal(read[0]?.stage, "verify")
})

test("append is best-effort: a missing runs/ dir records nothing and throws nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deny-log-none-"))
  appendDenyEntry(dir, "docs/tasks", entry("npm test"))
  assert.deepEqual(readDenyLog(dir, "docs/tasks"), [])
})

test("read skips malformed lines and caps at the last DENY_LOG_MAX entries", () => {
  const dir = tmpRepo()
  const file = denyLogPath(dir, "docs/tasks")
  const lines = ["not json", JSON.stringify({ command: "" }), JSON.stringify({ nope: true })]
  for (let i = 0; i < DENY_LOG_MAX + 20; i++) lines.push(JSON.stringify(entry(`cmd-${i.toString()}`)))
  fs.writeFileSync(file, lines.join("\n") + "\n")
  const read = readDenyLog(dir, "docs/tasks")
  assert.equal(read.length, DENY_LOG_MAX)
  assert.equal(read[0]?.command, "cmd-20", "oldest entries past the cap are dropped")
  assert.equal(read[read.length - 1]?.command, `cmd-${(DENY_LOG_MAX + 19).toString()}`)
})

test("parseDenyLine tolerates missing fields but requires a command", () => {
  assert.equal(parseDenyLine("{}"), null)
  const parsed = parseDenyLine(JSON.stringify({ command: "npm test" }))
  assert.deepEqual(parsed, { ts: "", host: "", kind: "", stage: "", command: "npm test" })
})

test("clearDenyLog removes the file exactly once", () => {
  const dir = tmpRepo()
  appendDenyEntry(dir, "docs/tasks", entry("npm test"))
  assert.equal(clearDenyLog(dir, "docs/tasks"), true)
  assert.equal(clearDenyLog(dir, "docs/tasks"), false)
  assert.deepEqual(readDenyLog(dir, "docs/tasks"), [])
})

test("suggestFor spots a rewriting proxy's prefix when the wrapped command is already allowed", () => {
  const globs = ["npm test*", "git status*"]
  assert.match(suggestFor("rtk npm test", globs) ?? "", /add "rtk" to bashAllowlistPrefix/)
  // A two-token prefix is recognized too (rtk proxy <cmd>).
  assert.match(suggestFor("rtk proxy git status", globs) ?? "", /add "rtk proxy" to bashAllowlistPrefix/)
})

test("suggestFor derives a narrow bashAllowlistExtra glob otherwise", () => {
  assert.match(suggestFor("pnpm --filter web test", ["npm test*"]) ?? "", /add "pnpm --filter \*" to bashAllowlistExtra/)
  assert.match(suggestFor("cargo nextest run", ["cargo test*"]) ?? "", /add "cargo nextest \*" to bashAllowlistExtra/)
  // No known globs: still suggests the extra, never the prefix (a prefix
  // suggestion needs proof the wrapped command was already allowed).
  assert.match(suggestFor("just ci", null) ?? "", /add "just ci \*" to bashAllowlistExtra/)
})

test("aggregateDenials groups by kind+stage+command, most-denied first, and formats", () => {
  const entries = [
    entry("pnpm --filter web test"),
    entry("pnpm --filter web test"),
    entry("rtk npm test"),
    entry("gh pr view 3", "review"),
  ]
  const findings = aggregateDenials(entries, (_kind, stage) => (stage === "verify" ? ["npm test*"] : null))
  assert.equal(findings.length, 3)
  assert.equal(findings[0]?.command, "pnpm --filter web test")
  assert.equal(findings[0]?.count, 2)
  assert.match(findings.find((f) => f.command === "rtk npm test")?.suggestion ?? "", /bashAllowlistPrefix/)
  // Unresolvable allowlist (unknown stage) still yields an extra-glob suggestion.
  assert.match(findings.find((f) => f.stage === "review")?.suggestion ?? "", /bashAllowlistExtra/)
  const lines = formatDenyFindings(findings)
  assert.match(lines[0] ?? "", /engineering VERIFY denied 2×: pnpm --filter web test/)
})
