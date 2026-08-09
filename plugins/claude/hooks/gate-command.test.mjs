import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end over the hook process itself. The pure halves (gate-parse,
 * gate-result, gate-ask, verb-slice) are unit-tested; this covers the GLUE that
 * composes them, which unit tests cannot see. It earned its place: `verbFor`
 * returning null for a non-engineering prompt was silently coerced to `status` by
 * `verbContext`, so every unrelated prompt in the session was answered with
 * engineering's status procedure. Both halves passed their own tests.
 *
 * The gate verbs shell to mcp-server/dist, so they used to be out of reach here.
 * They are not: the hook resolves the server from CLAUDE_PLUGIN_ROOT, so a
 * throwaway plugin root holding a canned `gate` CLI exercises the whole
 * dispatch → decide → continue-or-block chain. That chain is now conditional
 * (a task gate hands the turn back so the model can ask "plan it now?"), and
 * "which outcomes still block" is exactly the property no unit test can pin.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate-command.mjs")
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const run = (prompt, env = {}) => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt, cwd: process.cwd() }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  })
  assert.equal(res.status, 0, `the hook must never fail the turn: ${res.stderr}`)
  return res.stdout ? JSON.parse(res.stdout) : null
}

/**
 * A plugin root whose `gate` CLI prints one canned GateResult. The verbs/ dir is
 * symlinked (copied on failure) from the real plugin so the injected context is
 * the SHIPPED approve procedure, not a fixture — that is what makes the "the
 * follow-up's Yes branch reached the model" assertion meaningful.
 */
const fakeRoot = (result) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gate-"))
  fs.mkdirSync(path.join(root, "mcp-server", "dist"), { recursive: true })
  fs.writeFileSync(path.join(root, "mcp-server", "dist", "server.js"), `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)})\n`)
  try {
    fs.symlinkSync(path.join(PLUGIN_ROOT, "verbs"), path.join(root, "verbs"), "dir")
  } catch {
    fs.cpSync(path.join(PLUGIN_ROOT, "verbs"), path.join(root, "verbs"), { recursive: true })
  }
  return root
}

const approve = (result) => {
  const root = fakeRoot(result)
  return run("/agentic-workflow:engineering approve f7k3", {
    CLAUDE_PLUGIN_ROOT: root,
    AGENTIC_WORKFLOW_PLUGIN_ROOT: root,
    AGENTIC_WORKFLOW_SERVER_JS: path.join(root, "mcp-server", "dist", "server.js"),
  })
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

test("a gate verb runs the server named by AGENTIC_WORKFLOW_SERVER_JS, not one under the plugin root", () => {
  // Qwen installs `plugins/qwen` as its plugin root but REUSES the Claude
  // plugin's built server — `plugins/qwen/mcp-server/` does not exist. Deriving
  // the dist from the plugin root alone made `distExists` permanently false
  // there: every approve/replan/abandon/remove/retask blocked the turn with
  // "the plugin is not built — run ./install.sh qwen", which re-running the
  // installer could never fix, and the block denied the MCP fallback too.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gate-"))
  const stub = path.join(dir, "server.js")
  fs.writeFileSync(stub, `console.log(JSON.stringify({ ok: true, message: "stub gate ran" }))\n`)
  try {
    const out = run("/agentic-workflow:engineering approve x1-foo", {
      AGENTIC_WORKFLOW_PLUGIN_ROOT: dir, // deliberately a root with no mcp-server/
      AGENTIC_WORKFLOW_SERVER_JS: stub,
      CLAUDE_PLUGIN_ROOT: dir,
    })
    assert.equal(out?.decision, "block", "a completed gate blocks so the model cannot double-move")
    assert.match(out?.reason ?? "", /stub gate ran/, "the stamped server path must be the one that runs")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a plugin root with no server still reports not-built when nothing else names one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-gate-"))
  try {
    const out = run("/agentic-workflow:engineering approve x1-foo", {
      AGENTIC_WORKFLOW_PLUGIN_ROOT: dir,
      AGENTIC_WORKFLOW_SERVER_JS: "",
      CLAUDE_PLUGIN_ROOT: dir,
    })
    assert.equal(out?.decision, "block")
    assert.match(out?.reason ?? "", /not built/i)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The task gate is the one gate with an obvious next question. It used to block
 * the turn like every other gate, so `/agentic-workflow:engineering approve <id>`
 * could never ask whether to plan the task now — the model was never given a turn
 * in which to ask. These four cases pin both halves of the fix: the one gate that
 * continues, and the ones that must keep blocking.
 */
test("a task gate hands the turn back with the plan-it-now follow-up", () => {
  const out = approve({ ok: true, message: 'Task approved — "Do it" queued for planning.', data: { gate: "task", id: "f7k3" } })
  assert.notEqual(out?.decision, "block", "a blocked turn can never ask anything")
  const ctx = injected(out)
  assert.match(ctx, /Task approved/, "the deterministic outcome must ride along")
  assert.match(ctx, /GATE FOLLOW-UP/)
  assert.match(ctx, /AskUserQuestion/)
  assert.match(ctx, /f7k3/)
  // All three parts, in order: the outcome, then the verb's own procedure, then
  // the follow-up last — it is the instruction for THIS turn, and the approve
  // block it follows still describes a verb the model normally never sees.
  assert.match(ctx, /VERB INSTRUCTIONS — \/agentic-workflow:engineering approve/)
  assert.ok(ctx.indexOf("VERB INSTRUCTIONS") < ctx.indexOf("GATE FOLLOW-UP"), "the follow-up must come last")
})

test("the terminal ship gate still blocks — nothing follows a completed task", () => {
  const out = approve({ ok: true, message: '"Do it" shipped.', data: { gate: "ship", id: "f7k3" } })
  assert.equal(out?.decision, "block")
})

test("a refusal still blocks, whatever gate it names", () => {
  const out = approve({ ok: false, message: "Nothing awaiting approval.", data: { gate: "task", id: "f7k3" } })
  assert.equal(out?.decision, "block")
})

// Fail-safe: an mcp-server/dist older than the `data.gate` discriminator, or one
// that names a gate without a task id, must degrade to exactly the old behaviour
// rather than hand back a turn with a follow-up naming `undefined`.
test("a success the CLI could not describe blocks, as it always did", () => {
  for (const result of [
    { ok: true, message: "Task approved — queued." },
    { ok: true, message: "Task approved — queued.", data: { gate: "task" } },
    { ok: true, message: "Task approved — queued.", data: { gate: "nonsense", id: "f7k3" } },
  ]) {
    assert.equal(approve(result)?.decision, "block", JSON.stringify(result))
  }
})

test("a malformed payload never fails the turn", () => {
  const res = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, "")
})
