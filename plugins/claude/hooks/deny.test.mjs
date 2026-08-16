import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DENY_LOG_FILE, DENY_LOG_MAX_BYTES, noteDeny } from "./src/deny.mjs"

/**
 * The hook-side deny-log writer. Its records are read back by core's
 * `readDenyLog` (workflow/deny-log.ts), so the shape asserted here — one JSON
 * object per line with ts/host/kind/stage/command — is the cross-package
 * contract; a drift makes doctor silently blind to this host's denials.
 */

const tmpRuns = () => fs.mkdtempSync(path.join(os.tmpdir(), "deny-hook-"))

test("noteDeny appends one parseable line with the marker's kind and stage", () => {
  const runs = tmpRuns()
  noteDeny(runs, "claude", { kind: "engineering", stage: "verify" }, "pnpm --filter web test")
  noteDeny(runs, "qwen", { kind: "pr-sitter", stage: "pr-verify" }, "mvn clean test")
  const lines = fs
    .readFileSync(path.join(runs, DENY_LOG_FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].host, "claude")
  assert.equal(lines[0].kind, "engineering")
  assert.equal(lines[0].stage, "verify")
  assert.equal(lines[0].command, "pnpm --filter web test")
  assert.ok(typeof lines[0].ts === "string" && lines[0].ts.includes("T"))
  assert.equal(lines[1].stage, "pr-verify")
})

test("noteDeny tolerates a marker missing kind/stage and an empty command", () => {
  const runs = tmpRuns()
  noteDeny(runs, "claude", {}, "npm test")
  noteDeny(runs, "claude", null, "   ")
  const lines = fs
    .readFileSync(path.join(runs, DENY_LOG_FILE), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  assert.equal(lines.length, 1, "a blank command records nothing")
  assert.equal(lines[0].kind, "")
  assert.equal(lines[0].stage, "")
})

test("noteDeny never throws on an unwritable runs/ dir", () => {
  noteDeny(path.join(os.tmpdir(), "deny-hook-does-not-exist", "nested"), "claude", { stage: "verify" }, "npm test")
})

test("noteDeny stops appending past the byte cap instead of growing without bound", () => {
  const runs = tmpRuns()
  const file = path.join(runs, DENY_LOG_FILE)
  fs.writeFileSync(file, "x".repeat(DENY_LOG_MAX_BYTES + 1))
  noteDeny(runs, "claude", { stage: "verify" }, "npm test")
  assert.equal(fs.statSync(file).size, DENY_LOG_MAX_BYTES + 1, "no append past the cap")
})
