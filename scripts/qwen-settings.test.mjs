import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { mergeOwned, readSettings, resolveFragment, stripOwned } from "./qwen-settings.mjs"
import { bareModel, resolveAgentModels, withModel } from "./qwen-agents.mjs"

/**
 * The installer writes into settings.json — a file the USER owns. Every test
 * here guards the same promise: we add and remove exactly our own entries and
 * touch nothing else, so an uninstall is not a data-loss event.
 */

const fragment = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "plugins", "qwen", "hooks", "hooks.json"), "utf8"))
const resolved = () => resolveFragment(fragment, "/plugin/root", "/repo/dist/server.js")
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

test("every hook resolves the plugin root and declares every env var", () => {
  const r = resolved()
  const hooks = Object.values(r.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks))
  assert.ok(hooks.length >= 5, `expected every hook; got ${hooks.length}`)
  for (const h of hooks) {
    assert.doesNotMatch(h.command, /\$\{/, `unsubstituted placeholder in: ${h.command}`)
    assert.match(h.command, /^node "\/plugin\/root\/hooks\//)
    assert.equal(h.env.AGENTIC_WORKFLOW_HOST, "qwen")
    assert.equal(h.env.AGENTIC_WORKFLOW_PLUGIN_ROOT, "/plugin/root")
    // The server is NOT under the plugin root on this host — it is Claude's
    // build, reused. A hook that derives `<pluginRoot>/mcp-server/dist` finds
    // nothing, which is what made every gate verb refuse with "not built" and
    // banner-warned at the top of every healthy session.
    assert.equal(h.env.AGENTIC_WORKFLOW_SERVER_JS, "/repo/dist/server.js")
    assert.ok(String(h.name).startsWith("agentic-workflow"), `${h.name} would not be removed on uninstall`)
  }
})

test("the stamped server path is the one the MCP entry runs, not a plugin-root guess", () => {
  // The two must agree: the gate CLI and the MCP server are the same binary,
  // and a hook pointed anywhere else fails open into a fabricated gate.
  const r = resolved()
  const entry = mergeOwned({}, { serverJs: "/repo/dist/server.js", fragment: r }).mcpServers["agentic-workflow"]
  const hooks = Object.values(r.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks))
  for (const h of hooks) assert.equal(h.env.AGENTIC_WORKFLOW_SERVER_JS, entry.args[0])
  assert.ok(!entry.args[0].startsWith("/plugin/root"), "the qwen plugin root has no mcp-server/ — that was the bug")
})

test("resolveFragment omits the server var when no path is given", () => {
  // The `remove` path and any older caller pass no serverJs; stamping an
  // `undefined` would poison the env with a literal "undefined" path.
  const r = resolveFragment(fragment, "/plugin/root")
  const hooks = Object.values(r.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks))
  for (const h of hooks) assert.ok(!("AGENTIC_WORKFLOW_SERVER_JS" in h.env))
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

// qwen-agents.mjs keeps its own bareModel so the installer can run before
// @agentic-workflow/core is built (see its header). Duplication is what let the
// two drift: this file's copy stripped only the FIRST path segment, so a
// multi-segment id baked differently here than on every other host. Pin them.
test("the installer's bareModel takes the LAST provider segment, like core's", () => {
  assert.equal(bareModel("claude-sonnet-4-5"), "claude-sonnet-4-5")
  assert.equal(bareModel("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5")
  assert.equal(bareModel("openrouter/anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5")
  assert.equal(bareModel("a/b/c/d"), "d")
  assert.equal(bareModel(""), "")
  // Tolerates non-strings because it reads straight off unvalidated JSON.
  assert.equal(bareModel(42), 42)
})

// A source lint, not an import: this suite runs under plain `node --test` (see
// the root `test:scripts` script), so it cannot load core's TypeScript. Assert
// core still uses the same rule, so fixing one copy and not the other fails here
// rather than in a user's Qwen install.
test("core's bareModel still uses the last-segment rule these expectations encode", () => {
  const core = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages", "core", "src", "config-layers.ts"),
    "utf8",
  )
  const body = /export const bareModel[\s\S]*?\n\n/.exec(core)?.[0] ?? ""
  assert.match(body, /lastIndexOf\("\/"\)/, "core's bareModel no longer takes the last segment")
})

test("stageModels strip every provider segment, not just the first", () => {
  const { models } = resolveAgentModels(
    { workflows: { engineering: { stageModels: { verify: "openrouter/anthropic/fast-1" } } } },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], "fast-1")
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
test("one agent given two different stage models is left unset, not silently resolved", () => {
  // "Reported" has to mean UNSET: the installer prints "leaving the model
  // unset for that agent", and keeping the first-iterated kind's model made
  // that warning a lie — the agent file shipped with an arbitrary model baked
  // in, chosen by manifest directory order.
  const { models, conflicts } = resolveAgentModels(
    {
      workflows: {
        engineering: { stageModels: { verify: "fast-1" } },
        "pr-sitter": { stageModels: { verify: "fast-2" } },
      },
    },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], undefined)
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0], /workflow-verify/)
})

test("a third kind cannot resurrect a conflicted agent's model", () => {
  // The conflict is a property of the agent, not of the last pair compared.
  const { models, conflicts } = resolveAgentModels(
    {
      workflows: {
        engineering: { stageModels: { verify: "fast-1" } },
        "pr-sitter": { stageModels: { verify: "fast-2" } },
        "main-sitter": { stageModels: { verify: "fast-1" } },
      },
    },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], undefined)
  assert.ok(conflicts.length >= 1)
})

test("an explicit agentModels entry still resolves a conflicted agent", () => {
  // The documented way out — it is applied after the stage pass and wins
  // outright, so a conflict never leaves the operator stuck.
  const { models } = resolveAgentModels(
    {
      workflows: {
        engineering: { stageModels: { verify: "fast-1" } },
        "pr-sitter": { stageModels: { verify: "fast-2" } },
      },
      agentModels: { "workflow-verify": "provider/decided-1" },
    },
    MANIFESTS,
  )
  assert.equal(models["workflow-verify"], "decided-1")
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

test("an unparseable settings.json is refused, never merged into {}", () => {
  // The data-loss path this suite exists to prevent, and the one it missed: the
  // reader collapsed a parse failure into "absent", so a settings.json with a
  // trailing comma merged into `{}` and was written back holding nothing but
  // our own MCP server and hooks — the user's whole Qwen config, replaced, with
  // a success line printed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-settings-"))
  const file = path.join(dir, "settings.json")
  const original = '{\n  "theme": "dark",\n  "mcpServers": {},\n}\n' // trailing comma
  fs.writeFileSync(file, original)

  const read = readSettings(file)
  assert.ok(read.parseError, "a trailing comma must report a parse error, not an empty object")
  assert.equal(read.settings, undefined, "there is no merge base to hand back")
  assert.equal(fs.readFileSync(file, "utf8"), original, "reading must not touch the file")

  // Absent and empty are still "nothing to preserve" — a fresh install writes.
  assert.deepEqual(readSettings(path.join(dir, "nope.json")), { settings: {} })
  fs.writeFileSync(path.join(dir, "blank.json"), "   \n")
  assert.deepEqual(readSettings(path.join(dir, "blank.json")), { settings: {} })

  // A top level that parses but is not an object is refused too: merging into an
  // array would drop every key it holds.
  fs.writeFileSync(path.join(dir, "arr.json"), "[1,2]")
  assert.ok(readSettings(path.join(dir, "arr.json")).parseError)

  fs.rmSync(dir, { recursive: true, force: true })
})

test("temp-dir sanity: the fragment file this suite reads really exists", () => {
  assert.ok(fs.existsSync(path.join(os.tmpdir())), "tmpdir missing")
  assert.ok(fragment.hooks, "hooks.json has no hooks key")
})
