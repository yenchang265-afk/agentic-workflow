import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { dialectFor } from "./src/dialect.mjs"
import { EVIDENCE_MAX, evidenceEntry, noteEvidence, parseLedger, withEntry } from "./src/evidence.mjs"

/**
 * The check-stage proof-of-work ledger: the account of a stage's tool calls that
 * the AGENT does not write. `workflow_verdict` reads it back to reject a PASS the
 * stage did no work for (@agentic-workflow/core/workflow/evidence).
 */

const claude = dialectFor("claude")
const qwen = dialectFor("qwen")
const empty = { stage: "verify", commands: [], reads: [] }

test("a shell call is recorded as the EFFECTIVE command, not the one typed", () => {
  // The worktree pin may rewrite the command before it runs; what runs is what
  // counts as having been run.
  assert.deepEqual(evidenceEntry(claude, "Bash", { command: "npm test" }, "cd /wt && npm test"), {
    commands: ["cd /wt && npm test"],
    reads: [],
  })
})

test("a shell call falls back to the tool input when no effective command is passed", () => {
  assert.deepEqual(evidenceEntry(claude, "Bash", { command: "npm test" }), { commands: ["npm test"], reads: [] })
})

test("an empty command contributes nothing", () => {
  assert.equal(evidenceEntry(claude, "Bash", { command: "   " }, "   "), null)
})

test("read tools contribute their target path, on both hosts' spellings", () => {
  assert.deepEqual(evidenceEntry(claude, "Read", { file_path: "/wt/src/limit.ts" }), {
    commands: [],
    reads: ["/wt/src/limit.ts"],
  })
  assert.deepEqual(evidenceEntry(claude, "Grep", { path: "/wt/src" }), { commands: [], reads: ["/wt/src"] })
  assert.deepEqual(evidenceEntry(qwen, "read_file", { absolute_path: "/wt/src/limit.ts" }), {
    commands: [],
    reads: ["/wt/src/limit.ts"],
  })
})

test("a read tool carrying a list of paths records each", () => {
  assert.deepEqual(evidenceEntry(qwen, "read_many_files", { paths: ["/wt/a.ts", "/wt/b.ts"] }), {
    commands: [],
    reads: ["/wt/a.ts", "/wt/b.ts"],
  })
})

test("a WRITE is not evidence of having looked at anything", () => {
  // Only inspection counts. A stage that edits a file has not thereby verified it,
  // and check stages are read-only anyway.
  assert.equal(evidenceEntry(claude, "Write", { file_path: "/wt/src/limit.ts" }), null)
  assert.equal(evidenceEntry(claude, "Edit", { file_path: "/wt/src/limit.ts" }), null)
  assert.equal(evidenceEntry(claude, "SomeMcpTool", { file_path: "/wt/src/limit.ts" }), null)
})

test("withEntry de-dupes: re-reading one file thirty times is one file observed", () => {
  let ledger = empty
  for (let i = 0; i < 30; i++) ledger = withEntry(ledger, { commands: [], reads: ["/wt/a.ts"] })
  assert.deepEqual(ledger.reads, ["/wt/a.ts"])
})

test("withEntry caps each channel, DROPPING the overflow rather than rotating it", () => {
  // Rotation would let a stage flush an inconvenient early command out of the
  // record by running a few hundred harmless ones.
  let ledger = empty
  for (let i = 0; i < EVIDENCE_MAX + 10; i++) ledger = withEntry(ledger, { commands: [`cmd-${i}`], reads: [] })
  assert.equal(ledger.commands.length, EVIDENCE_MAX)
  assert.equal(ledger.commands[0], "cmd-0", "the first command survives the flood")
  assert.ok(!ledger.commands.includes(`cmd-${EVIDENCE_MAX + 5}`))
})

test("parseLedger rejects a blob that is not a ledger, and keeps only strings", () => {
  assert.equal(parseLedger("not json"), null)
  assert.equal(parseLedger("42"), null)
  assert.deepEqual(parseLedger('{"stage":"verify","commands":["a",7],"reads":null}'), {
    stage: "verify",
    commands: ["a"],
    reads: [],
  })
})

test("noteEvidence starts a fresh ledger when the one on disk belongs to another stage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-evidence-"))
  const file = path.join(dir, claude.evidenceFile)
  fs.writeFileSync(file, JSON.stringify({ stage: "build", commands: ["npm run build"], reads: [] }))
  noteEvidence(dir, claude.evidenceFile, "verify", { commands: ["npm test"], reads: [] })
  // A previous stage's work must never corroborate this stage's PASS.
  assert.deepEqual(parseLedger(fs.readFileSync(file, "utf8")), { stage: "verify", commands: ["npm test"], reads: [] })
})

test("noteEvidence appends within one stage and never throws on an unwritable dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-evidence-"))
  noteEvidence(dir, claude.evidenceFile, "verify", { commands: ["npm test"], reads: [] })
  noteEvidence(dir, claude.evidenceFile, "verify", { commands: [], reads: ["/wt/a.ts"] })
  assert.deepEqual(parseLedger(fs.readFileSync(path.join(dir, claude.evidenceFile), "utf8")), {
    stage: "verify",
    commands: ["npm test"],
    reads: ["/wt/a.ts"],
  })
  // Bookkeeping must never fail a tool call: a guard that blocks a stage over its
  // own ledger is worse than a weaker gate.
  assert.doesNotThrow(() => noteEvidence(path.join(dir, "nope", "nope"), claude.evidenceFile, "verify", { commands: ["x"], reads: [] }))
  assert.doesNotThrow(() => noteEvidence(dir, claude.evidenceFile, "verify", null))
})

test("each host writes its own ledger — one host's session cannot corroborate another's PASS", () => {
  assert.notEqual(claude.evidenceFile, qwen.evidenceFile)
})


// --- hook wiring: an unrouted recorder records nothing ---

const HERE = path.dirname(fileURLToPath(import.meta.url))
const hooksJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const matcherFor = (json, bundle) => {
  const entry = json.hooks.PreToolUse.find((e) => (e.hooks ?? []).some((h) => String(h.command).includes(bundle)))
  assert.ok(entry, `no PreToolUse entry runs ${bundle}`)
  return new RegExp(`^(?:${entry.matcher})$`)
}

test("the recorder is routed to each host's read tools — its whole reason for existing", () => {
  // REVIEW's work is almost entirely reading. Unrouted, its ledger stays empty
  // and the proof-of-work gate rejects every honest PASS.
  const claudeRe = matcherFor(hooksJson(path.join(HERE, "hooks.json")), "check-evidence.mjs")
  for (const tool of claude.read) assert.ok(claudeRe.test(tool), `${tool} is not routed to check-evidence`)

  const qwenRe = matcherFor(hooksJson(path.join(HERE, "..", "..", "qwen", "hooks", "hooks.json")), "check-evidence.mjs")
  for (const tool of qwen.read) assert.ok(qwenRe.test(tool), `${tool} is not routed to check-evidence on qwen`)
})

test("the recorder's matcher is disjoint from the guard's — no call is seen by two PreToolUse hooks", () => {
  // Two PreToolUse hooks on one call is undocumented behaviour; the split also
  // keeps the policies apart (the guard fails CLOSED, the recorder always allows).
  for (const [file, dialect] of [
    [path.join(HERE, "hooks.json"), claude],
    [path.join(HERE, "..", "..", "qwen", "hooks", "hooks.json"), qwen],
  ]) {
    const json = hooksJson(file)
    const guard = matcherFor(json, "check-stage-guard.mjs")
    const recorder = matcherFor(json, "check-evidence.mjs")
    for (const tool of dialect.read) assert.equal(guard.test(tool), false, `${tool} would hit both hooks`)
    for (const tool of [...dialect.bash, ...dialect.write]) {
      assert.equal(recorder.test(tool), false, `${tool} would hit both hooks`)
    }
  }
})
