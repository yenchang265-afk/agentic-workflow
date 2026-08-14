import assert from "node:assert/strict"
import { test } from "node:test"
import {
  canonicalTool,
  dialectFor,
  hostFor,
  isBashTool,
  isWriteTool,
  KNOWN_HOSTS,
  unknownHostMessage,
  writePathKeyOf,
  writePathOf,
} from "./src/dialect.mjs"

/**
 * The tool-identity dialect the PreToolUse guard keys off. Every assertion here
 * guards the same failure mode: a name that does not match is not an error, it
 * is a tool the guard silently waves through. That is why the host resolution
 * fails closed and why the legacy Qwen alias is covered.
 */

test("an unset or empty AGENTIC_WORKFLOW_HOST means Claude Code", () => {
  assert.equal(hostFor({}), "claude")
  // Wrappers and installers propagate empty env vars; empty means "not specified".
  assert.equal(hostFor({ AGENTIC_WORKFLOW_HOST: "" }), "claude")
})

test("every known host resolves to a dialect", () => {
  for (const host of KNOWN_HOSTS) {
    const d = dialectFor(hostFor({ AGENTIC_WORKFLOW_HOST: host }))
    assert.ok(d, `${host} has no dialect`)
    assert.ok(d.bash.length > 0, `${host} names no shell tool`)
    assert.ok(d.write.length > 0, `${host} names no write tool`)
    assert.match(d.stageMarkerFile, /^\.stage.*\.json$/, `${host}'s marker file looks wrong`)
    assert.equal(typeof d.conveysSpawnModel, "boolean", `${host} must declare conveysSpawnModel explicitly`)
    assert.ok(d.askTool, `${host} names no question tool`)
  }
})

// A gate follow-up that names the wrong question tool is worse than none: the
// model tries to call a tool that does not exist on its host and the gate ask
// silently degrades to chat prose — the exact failure gen-prompts.mjs's
// {{askTool}} token was introduced to end.
test("each host names its own question tool", () => {
  assert.equal(dialectFor("claude").askTool, "AskUserQuestion")
  assert.equal(dialectFor("qwen").askTool, "ask_user_question")
})

// Defaulting a typo'd host to Claude would leave every Qwen tool name matching
// nothing, so the guard would allow every backlog mutation while looking healthy.
test("an unknown host resolves to null, never to a fallback dialect", () => {
  assert.equal(hostFor({ AGENTIC_WORKFLOW_HOST: "claude-code" }), null)
  assert.equal(dialectFor(null), null)
  assert.match(unknownHostMessage("claude-code"), /not a known host/)
})

test("no two hosts share a stage-marker file", () => {
  const files = KNOWN_HOSTS.map((h) => dialectFor(h).stageMarkerFile)
  assert.equal(new Set(files).size, files.length, `two hosts share a marker: ${files.join(", ")}`)
})

// A stale sentinel from one host's run must not suppress (or falsely arm) the
// other host's SubagentStop nag on the same repo — same reason the stage
// marker and evidence ledger are per-host.
test("no two hosts share a verdict-nag file, and every host declares one", () => {
  for (const host of KNOWN_HOSTS) assert.ok(dialectFor(host).verdictNagFile, `${host} names no verdict-nag file`)
  const files = KNOWN_HOSTS.map((h) => dialectFor(h).verdictNagFile)
  assert.equal(new Set(files).size, files.length, `two hosts share a verdict-nag sentinel: ${files.join(", ")}`)
})

test("Claude tool names classify", () => {
  const d = dialectFor("claude")
  assert.ok(isBashTool(d, "Bash"))
  for (const t of ["Edit", "Write", "NotebookEdit"]) assert.ok(isWriteTool(d, t), `${t} is not a write tool`)
  assert.ok(!isWriteTool(d, "Read"))
  assert.ok(!isBashTool(d, "run_shell_command"), "the Claude dialect must not match Qwen's shell tool")
})

test("Qwen tool names classify, including the legacy `replace` alias for `edit`", () => {
  const d = dialectFor("qwen")
  assert.ok(isBashTool(d, "run_shell_command"))
  for (const t of ["write_file", "edit", "replace", "notebook_edit"]) {
    assert.ok(isWriteTool(d, t), `${t} is not a write tool`)
  }
  assert.ok(!isBashTool(d, "Bash"), "the Qwen dialect must not match Claude's shell tool")
  assert.ok(!isWriteTool(d, "read_file"))
})

// core's classifyMutation matches the Claude spelling, so a Qwen name must be
// translated before it reaches the always-on backlog guard.
test("canonicalTool maps each host's names onto the spelling core matches", () => {
  assert.equal(canonicalTool(dialectFor("qwen"), "run_shell_command"), "Bash")
  assert.equal(canonicalTool(dialectFor("qwen"), "write_file"), "Write")
  assert.equal(canonicalTool(dialectFor("claude"), "Bash"), "Bash")
  assert.equal(canonicalTool(dialectFor("claude"), "NotebookEdit"), "Write")
  // An unrecognized tool passes through unchanged — core then classifies it as
  // "not a mutation", which is correct for e.g. a read.
  assert.equal(canonicalTool(dialectFor("claude"), "WebFetch"), "WebFetch")
  assert.equal(canonicalTool(dialectFor("claude"), undefined), "")
})

test("the write path is probed and rewritten under the same key", () => {
  assert.equal(writePathOf({ file_path: "/a" }), "/a")
  assert.equal(writePathOf({ notebook_path: "/n" }), "/n")
  assert.equal(writePathOf({ command: "ls" }), undefined)
  assert.equal(writePathKeyOf({ notebook_path: "/n" }), "notebook_path")
  // Fail-safe default so a rewrite never invents a second key.
  assert.equal(writePathKeyOf({}), "file_path")
})

// Qwen's `agent` tool has no model parameter; the model is baked into the
// installed agent file. A host that "forgot" to declare this would get prose
// telling the orchestrator to set a parameter that does not exist.
test("only hosts whose spawn tool takes a model declare conveysSpawnModel", () => {
  assert.equal(dialectFor("claude").conveysSpawnModel, true)
  assert.equal(dialectFor("qwen").conveysSpawnModel, false)
})
