import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { mergeOwned, resolveFragment, stripOwned } from "./qwen-settings.mjs"
import { resolveAgentModels, withModel } from "./qwen-agents.mjs"

/**
 * The installer writes into settings.json — a file the USER owns. Every test
 * here guards the same promise: we add and remove exactly our own entries and
 * touch nothing else, so an uninstall is not a data-loss event.
 */

const fragment = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "plugins", "qwen", "hooks", "hooks.json"), "utf8"))
const resolved = () => resolveFragment(fragment, "/plugin/root")
const merge = (settings) => mergeOwned(settings, { serverJs: "/repo/dist/server.js", fragment: resolved() })

test("merge preserves unrelated keys verbatim", () => {
  const before = { theme: "dark", telemetry: { enabled: false }, someFutureKey: [1, 2, 3] }
  const after = merge(before)
  assert.equal(after.theme, "dark")
  assert.deepEqual(after.telemetry, { enabled: false })
  assert.deepEqual(after.someFutureKey, [1, 2, 3])
})

test("merge then strip returns the original settings exactly", () => {
  const before = { theme: "dark", mcpServers: { other: { command: "x" } } }
  assert.deepEqual(stripOwned(merge(before)), before)
})

// A second install must not append a second copy of every hook.
test("merge is idempotent", () => {
  const once = merge({ theme: "dark" })
  const twice = merge(once)
  assert.deepEqual(twice, once)
})

test("a user's own hook on the same event survives both merge and remove", () => {
  const mine = { type: "command", name: "my-own", command: "echo hi" }
  const before = { hooks: { SessionStart: [{ hooks: [mine] }] } }
  const after = merge(before)
  const names = after.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.name))
  assert.ok(names.includes("my-own"), "the user's hook was dropped by merge")
  assert.ok(names.some((n) => n.startsWith("agentic-workflow")), "our hooks were not added")
  assert.deepEqual(stripOwned(after), before, "remove did not restore the user's file")
})

test("a user's own MCP server survives", () => {
  const before = { mcpServers: { github: { command: "gh-mcp" } } }
  const after = merge(before)
  assert.deepEqual(after.mcpServers.github, { command: "gh-mcp" })
  assert.deepEqual(stripOwned(after), before)
})

test("stripping a file we were never merged into is a no-op", () => {
  const before = { theme: "dark", hooks: { SessionStart: [{ hooks: [{ name: "theirs", command: "x" }] }] } }
  assert.deepEqual(stripOwned(before), before)
})

// The host switch is what makes the shared MCP binary behave as the Qwen host;
// without it the server would namespace agents and write Claude's stage marker.
test("the merged MCP server carries the qwen host switch and an absolute server path", () => {
  const entry = merge({}).mcpServers["agentic-workflow"]
  assert.equal(entry.env.AGENTIC_WORKFLOW_HOST, "qwen")
  assert.equal(entry.args[0], "/repo/dist/server.js")
})

test("every hook resolves the plugin root and declares both env vars", () => {
  const r = resolved()
  const hooks = Object.values(r.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks))
  assert.ok(hooks.length >= 5, `expected every hook; got ${hooks.length}`)
  for (const h of hooks) {
    assert.doesNotMatch(h.command, /\$\{/, `unsubstituted placeholder in: ${h.command}`)
    assert.match(h.command, /^node "\/plugin\/root\/hooks\//)
    assert.equal(h.env.AGENTIC_WORKFLOW_HOST, "qwen")
    assert.equal(h.env.AGENTIC_WORKFLOW_PLUGIN_ROOT, "/plugin/root")
    assert.ok(String(h.name).startsWith("agentic-workflow"), `${h.name} would not be removed on uninstall`)
  }
})

// The four events must match the Claude plugin's, or a guard silently never runs.
test("the fragment covers the same four hook events the Claude plugin registers", () => {
  const claude = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "plugins", "claude", "hooks", "hooks.json"), "utf8"),
  )
  assert.deepEqual(Object.keys(fragment.hooks).sort(), Object.keys(claude.hooks).sort())
})

// Qwen's PreToolUse matcher keys off ITS tool ids; Claude's names would match
// nothing, so the stage guard would never fire.
test("the PreToolUse matcher names Qwen's tool ids, not Claude's", () => {
  const matcher = fragment.hooks.PreToolUse[0].matcher
  for (const id of ["run_shell_command", "write_file", "edit", "mcp__"]) {
    assert.ok(matcher.includes(id), `matcher is missing ${id}`)
  }
  assert.ok(!/\bBash\b/.test(matcher), "matcher still names Claude's Bash tool")
})

/* --- qwen-agents: the model baking --- */

const AGENT = "---\nname: workflow-verify\ndescription: d\ntools:\n  - read_file\n---\n\nbody\n"

test("withModel injects, replaces, and removes the model line", () => {
  assert.match(withModel(AGENT, "m1"), /^model: m1$/m)
  assert.match(withModel(withModel(AGENT, "m1"), "m2"), /^model: m2$/m)
  assert.equal((withModel(withModel(AGENT, "m1"), "m2").match(/^model:/gm) ?? []).length, 1)
  // No configured model → the file is unchanged and `model` stays absent, which
  // Qwen reads as `inherit`.
  assert.equal(withModel(AGENT, undefined), AGENT)
})

test("withModel preserves the body", () => {
  assert.ok(withModel(AGENT, "m").endsWith("\nbody\n"))
})

const MANIFESTS = [
  { kind: "engineering", stages: [{ name: "verify", agent: "workflow-verify" }, { name: "build", agent: "workflow-build" }] },
  { kind: "pr-sitter", stages: [{ name: "verify", agent: "workflow-verify" }] },
]

test("stageModels resolve onto the agent backing that stage, provider prefix stripped", () => {
  const { models, conflicts } = resolveAgentModels(
    { workflows: { engineering: { stageModels: { verify: "anthropic/fast-1" } } } },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], "fast-1")
  assert.equal(models["workflow-build"], undefined)
  assert.deepEqual(conflicts, [])
})

test("agentModels wins over the stage-derived model", () => {
  const { models } = resolveAgentModels(
    { workflows: { engineering: { stageModels: { verify: "fast-1" } } }, agentModels: { "workflow-verify": "big-1" } },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], "big-1")
})

// workflow-verify backs a stage in four kinds today. Two kinds asking for
// different models is a genuine ambiguity a static binding cannot express, so it
// is reported rather than resolved by whichever manifest happened to load last.
test("one agent given two different stage models is reported, not silently resolved", () => {
  const { models, conflicts } = resolveAgentModels(
    {
      workflows: {
        engineering: { stageModels: { verify: "fast-1" } },
        "pr-sitter": { stageModels: { verify: "fast-2" } },
      },
    },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], "fast-1")
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /workflow-verify/)
})

test("the same model in two kinds is not a conflict", () => {
  const { conflicts } = resolveAgentModels(
    {
      workflows: {
        engineering: { stageModels: { verify: "provider/fast-1" } },
        "pr-sitter": { stageModels: { verify: "fast-1" } },
      },
    },
    MANIFESTS,
  )
  assert.deepEqual(conflicts, [])
})

test("an empty config bakes nothing", () => {
  const { models, conflicts } = resolveAgentModels({}, MANIFESTS)
  assert.deepEqual(models, {})
  assert.deepEqual(conflicts, [])
})

test("temp-dir sanity: the fragment file this suite reads really exists", () => {
  assert.ok(fs.existsSync(path.join(os.tmpdir())), "tmpdir missing")
  assert.ok(fragment.hooks, "hooks.json has no hooks key")
})
