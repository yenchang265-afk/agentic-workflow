import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The BUILT stamp-spawn-model.mjs, driven end-to-end over the real hook contract
 * (stdin JSON; exit 0 allows, exit 0 plus an `updatedInput` envelope rewrites).
 *
 * This is the file that proves the model binding is a MECHANISM rather than a
 * request. `stageModels`/`agentModels` used to reach a spawn as prose the
 * orchestrator could ignore — and did, silently, with every stage running the
 * host default. Asserting on prose could never catch that; asserting that the
 * spawn call itself comes out carrying the configured model can.
 *
 * Two properties matter most here and are easy to lose in a refactor:
 *
 *  - the envelope carries EVERY original key, because `updatedInput` replaces
 *    `tool_input` wholesale rather than merging into it;
 *  - an unmappable model produces NO envelope. Claude Code validates `model`
 *    against `sonnet|opus|haiku|fable` and errors the entire spawn on a miss, so
 *    "stamp it and hope" would turn a cosmetic misconfig into an outage.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "stamp-spawn-model.mjs")

/** A scratch repo, optionally with a config layer and a live stage marker. */
const makeRepo = ({ config, marker } = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-stamp-"))
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(cwd, ".agentic-workflow.json"),
      typeof config === "string" ? config : JSON.stringify(config),
    )
  }
  if (marker !== undefined) {
    fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
    fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", ".stage.json"), JSON.stringify(marker))
  }
  return cwd
}

const SPAWN = { description: "plan it", prompt: "do the thing", subagent_type: "agentic-workflow:workflow-plan", run_in_background: false }

const run = (cwd, tool_input, { tool_name = "Agent", host } = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_name, tool_input }),
    encoding: "utf8",
    // A developer's real user-scope config must never leak into these cases.
    env: { ...process.env, AGENTIC_WORKFLOW_USER_CONFIG: "", ...(host === undefined ? {} : { AGENTIC_WORKFLOW_HOST: host }) },
  })

/** The `updatedInput` the hook emitted, or null when it allowed the call as-is. */
const rewriteOf = (out) => {
  assert.equal(out.status, 0, out.stderr)
  if (!out.stdout.trim()) return null
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse")
  // Correct the input; never also grant permission — an "allow" here would let a
  // spawn skip a prompt it would otherwise have faced, purely because we stamped it.
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined)
  return parsed.hookSpecificOutput.updatedInput
}

test("a configured agentModels entry is stamped onto the spawn, preserving every original key", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.deepEqual(rewriteOf(run(cwd, SPAWN)), { ...SPAWN, model: "haiku" })
})

test("a full model id is mapped to the alias the spawn tool accepts", () => {
  for (const [configured, alias] of [
    ["anthropic/claude-haiku-4-5", "haiku"],
    ["claude-sonnet-4-5", "sonnet"],
    ["openrouter/anthropic/claude-3-5-sonnet-20241022", "sonnet"],
    ["claude-opus-5", "opus"],
  ]) {
    const cwd = makeRepo({ config: { agentModels: { "workflow-plan": configured } } })
    assert.equal(rewriteOf(run(cwd, SPAWN))?.model, alias, `configured: ${configured}`)
  }
})

test("an unmappable model is NOT stamped — a rejected value would error the whole spawn", () => {
  for (const configured of ["gpt-4o", "llama-3", "claude-nonexistent-9"]) {
    const cwd = makeRepo({ config: { agentModels: { "workflow-plan": configured } } })
    assert.equal(rewriteOf(run(cwd, SPAWN)), null, `configured: ${configured}`)
  }
})

test("the stage marker's stageAgentModels binds a stage spawn", () => {
  const cwd = makeRepo({
    marker: { kind: "engineering", stage: "build", agent: "workflow-build", stageAgentModels: { "workflow-build": "opus" } },
  })
  const input = { ...SPAWN, subagent_type: "agentic-workflow:workflow-build" }
  assert.equal(rewriteOf(run(cwd, input))?.model, "opus")
})

// workflow_advance returns the NEXT stage's fire payload without rewriting the
// marker (it defers to workflow_stage), so at the moment BUILD is re-fired after
// a VERIFY FAIL the marker still says stage=verify. Keying off the AGENT rather
// than the current stage is what keeps iteration 2+ bound; a single
// current-stage `model` field would silently drop back to the host default here.
test("a stage agent is bound even when the marker's current stage is a different one", () => {
  const cwd = makeRepo({
    marker: {
      kind: "engineering",
      stage: "verify",
      agent: "workflow-verify",
      stageAgentModels: { "workflow-build": "opus", "workflow-verify": "haiku" },
    },
  })
  const input = { ...SPAWN, subagent_type: "agentic-workflow:workflow-build" }
  assert.equal(rewriteOf(run(cwd, input))?.model, "opus")
})

test("the marker wins over agentModels for the same agent", () => {
  // agentModels is for spawns that are NOT stage runs; letting it win would let
  // it retarget a stage, which is the bleed the two settings exist to keep apart.
  const cwd = makeRepo({
    config: { agentModels: { "workflow-build": "haiku" } },
    marker: { stage: "build", agent: "workflow-build", stageAgentModels: { "workflow-build": "opus" } },
  })
  const input = { ...SPAWN, subagent_type: "agentic-workflow:workflow-build" }
  assert.equal(rewriteOf(run(cwd, input))?.model, "opus")
})

test("an unprefixed subagent_type still resolves", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.equal(rewriteOf(run(cwd, { ...SPAWN, subagent_type: "workflow-plan" }))?.model, "haiku")
})

test("nothing configured means no envelope at all", () => {
  assert.equal(rewriteOf(run(makeRepo(), SPAWN)), null)
  assert.equal(rewriteOf(run(makeRepo({ config: {} }), SPAWN)), null)
  assert.equal(rewriteOf(run(makeRepo({ config: { agentModels: {} } }), SPAWN)), null)
})

test("agents this plugin does not ship are never retargeted", () => {
  // Otherwise `agentModels: {"general-purpose": "opus"}` would rebind a host
  // built-in the user never meant to touch.
  for (const subagent_type of ["general-purpose", "Explore", "statusline-setup"]) {
    const cwd = makeRepo({ config: { agentModels: { [subagent_type]: "haiku" } } })
    assert.equal(rewriteOf(run(cwd, { ...SPAWN, subagent_type })), null, subagent_type)
  }
})

test("a non-spawn tool is never touched", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  for (const tool_name of ["Bash", "Edit", "Write", "mcp__agentic-workflow__workflow_stage"]) {
    assert.equal(rewriteOf(run(cwd, SPAWN, { tool_name })), null, tool_name)
  }
})

test("the legacy Task spelling is stamped too", () => {
  // Task was renamed Agent in 2.1.63 and still works as an alias; a rename that
  // silently stopped matching would disable the binding without failing anything.
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.equal(rewriteOf(run(cwd, SPAWN, { tool_name: "Task" }))?.model, "haiku")
})

test("malformed config degrades to the host default instead of throwing", () => {
  for (const config of ["{ not json", '"a string"', "[1,2,3]", JSON.stringify({ agentModels: 42 }), JSON.stringify({ agentModels: { "workflow-plan": 42 } })]) {
    const cwd = makeRepo({ config })
    assert.equal(rewriteOf(run(cwd, SPAWN)), null, config)
  }
})

test("a malformed marker degrades to the config layer rather than throwing", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", ".stage.json"), "{ not json")
  assert.equal(rewriteOf(run(cwd, SPAWN))?.model, "haiku")
})

test("Qwen no-ops: its agent tool has no model parameter to stamp", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.equal(rewriteOf(run(cwd, SPAWN, { host: "qwen" })), null)
})

test("an unknown host fails OPEN — this is a convenience binding, not a security control", () => {
  // The deliberate divergence from check-stage-guard.entry.mjs, which exits 2 on
  // an unknown host because guessing a dialect disarms every rule it enforces.
  // Refusing every subagent spawn in a session over a typo'd env var would be a
  // far worse failure than running the default model.
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  const out = run(cwd, SPAWN, { host: "bogus" })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout.trim(), "")
})

test("an already-correct model produces no envelope", () => {
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.equal(rewriteOf(run(cwd, { ...SPAWN, model: "haiku" })), null)
})

test("a different model the orchestrator chose is overridden by config", () => {
  // Recorded as a decision, not an accident: the config is the user's standing,
  // explicit instruction; an in-turn pick is a guess its author never saw. The
  // escape hatch is unsetting the key.
  const cwd = makeRepo({ config: { agentModels: { "workflow-plan": "haiku" } } })
  assert.equal(rewriteOf(run(cwd, { ...SPAWN, model: "opus" }))?.model, "haiku")
})
