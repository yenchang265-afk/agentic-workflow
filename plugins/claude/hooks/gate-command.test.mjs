import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end over the hook process itself. The pure halves (gate-parse,
 * gate-result, verb-slice) are unit-tested; this covers the GLUE that composes
 * them, which unit tests cannot see. It earned its place: `verbFor` returning
 * null for a non-engineering prompt was silently coerced to `status` by
 * `verbContext`, so every unrelated prompt in the session was answered with
 * engineering's status procedure. Both halves passed their own tests.
 *
 * Only prompts that need no MCP server are exercised — a gate verb would shell
 * to mcp-server/dist and its behaviour is decideGateOutcome's contract.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate-command.mjs")
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const run = (prompt) => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt, cwd: process.cwd() }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  })
  assert.equal(res.status, 0, `the hook must never fail the turn: ${res.stderr}`)
  return res.stdout ? JSON.parse(res.stdout) : null
}

const injected = (out) => out?.hookSpecificOutput?.additionalContext ?? ""

test("an engineering verb gets its own procedure injected", () => {
  const out = run("/agentic-workflow:engineering new abc")
  assert.match(injected(out), /VERB INSTRUCTIONS — \/agentic-workflow:engineering new/)
  assert.match(injected(out), /interview/i)
  assert.doesNotMatch(injected(out), /workflow_doctor/, "another verb's procedure must not come along")
})

test("each verb gets a different procedure", () => {
  assert.notEqual(injected(run("/agentic-workflow:engineering new abc")), injected(run("/agentic-workflow:engineering claim")))
  assert.match(injected(run("/agentic-workflow:engineering doctor")), /workflow_doctor/)
})

test("a bare engineering command gets the status procedure", () => {
  assert.match(injected(run("/agentic-workflow:engineering")), /VERB INSTRUCTIONS — \/agentic-workflow:engineering status/)
})

test("another kind's command is left completely alone", () => {
  // This hook's matcher is "", so it sees every prompt in the session.
  assert.equal(run("/agentic-workflow:pr-sitter claim"), null, "no stdout at all")
})

test("ordinary prose is left completely alone", () => {
  for (const prompt of ["just some prose", "the engineering approve step happens later", "please review my PR"]) {
    assert.equal(run(prompt), null, prompt)
  }
})

test("an id-less gate verb blocks with usage — no model turn, no spawn", () => {
  // Deterministic usage refusal, matching the OpenCode host. Needs no MCP
  // server: the block happens before any dispatch, which is also why this
  // e2e can cover a gate-shaped prompt at all (see the header).
  const out = run("/agentic-workflow:engineering retask")
  assert.equal(out?.decision, "block")
  assert.match(out?.reason ?? "", /Usage: \/agentic-workflow:engineering retask <id> \[note\]\./)
})

test("a malformed payload never fails the turn", () => {
  const res = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, "")
})
