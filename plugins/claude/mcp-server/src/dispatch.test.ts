import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Every manifest `stage.agent` flows through four independently-maintained
// places that must all agree on the exact same string, with nothing today
// that enforces it end to end:
//   packages/core/workflows/<kind>/workflow.json  "agent": "<name>"
//   plugins/claude/agents/<name>.md                frontmatter name: <name>
//   server.ts's agentRef(name) => `agentic-workflow:${name}`  (prefix format)
//   plugins/opencode/commands/<cmd>.md              agent: <name>  →
//     plugins/opencode/agents/<name>.md filename (OpenCode has no frontmatter
//     `name:` fallback — it resolves an agent purely by filename stem)
// A mismatch anywhere in this chain is a silent dispatch failure: Claude
// Code's Task tool, or OpenCode's command runner, would try to invoke an
// agent identity that doesn't exist. Source-level, like the spawn-model-note
// test above: these are on-disk artifacts, not importable module internals.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const WORKFLOWS_DIR = path.join(ROOT, "packages", "core", "workflows")
const CLAUDE_AGENTS_DIR = path.join(ROOT, "plugins", "claude", "agents")
const OPENCODE_AGENTS_DIR = path.join(ROOT, "plugins", "opencode", "agents")
const OPENCODE_COMMANDS_DIR = path.join(ROOT, "plugins", "opencode", "commands")
const SERVER_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts")

const manifestAgents = (): readonly string[] => {
  const agents = new Set<string>()
  for (const kind of fs.readdirSync(WORKFLOWS_DIR)) {
    const manifestPath = path.join(WORKFLOWS_DIR, kind, "workflow.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { stages?: readonly { agent?: string }[] }
    for (const stage of manifest.stages ?? []) if (stage.agent) agents.add(stage.agent)
  }
  return [...agents].sort()
}

const frontmatterField = (src: string, field: string): string | undefined => {
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(src)
  return m?.[1]?.trim()
}

test("every workflow.json agent has a matching plugins/claude/agents/<name>.md with the same frontmatter name", () => {
  const agents = manifestAgents()
  assert.ok(agents.length >= 10, `expected to find at least 10 distinct stage agents; got ${agents.length}`)
  for (const agent of agents) {
    const agentPath = path.join(CLAUDE_AGENTS_DIR, `${agent}.md`)
    assert.ok(fs.existsSync(agentPath), `manifest names agent "${agent}" but ${agentPath} does not exist`)
    const name = frontmatterField(fs.readFileSync(agentPath, "utf8"), "name")
    assert.equal(name, agent, `${agentPath} frontmatter "name: ${name}" does not match the manifest agent "${agent}"`)
  }
})

test("every workflow.json agent has a matching plugins/opencode/agents/<name>.md (OpenCode resolves by filename only)", () => {
  const agents = manifestAgents()
  for (const agent of agents) {
    const agentPath = path.join(OPENCODE_AGENTS_DIR, `${agent}.md`)
    assert.ok(fs.existsSync(agentPath), `manifest names agent "${agent}" but ${agentPath} does not exist`)
  }
})

test("every OpenCode command's agent: frontmatter names an agent file that actually exists", () => {
  const commandFiles = fs.readdirSync(OPENCODE_COMMANDS_DIR).filter((f) => f.endsWith(".md"))
  assert.ok(commandFiles.length > 0, "expected at least one OpenCode command file")
  let checked = 0
  for (const file of commandFiles) {
    const src = fs.readFileSync(path.join(OPENCODE_COMMANDS_DIR, file), "utf8")
    const agent = frontmatterField(src, "agent")
    if (!agent) continue
    const agentPath = path.join(OPENCODE_AGENTS_DIR, `${agent}.md`)
    assert.ok(fs.existsSync(agentPath), `${file} declares agent: ${agent}, but ${agentPath} does not exist`)
    checked++
  }
  assert.ok(checked >= 10, `expected at least 10 command files with an agent: frontmatter; checked ${checked}`)
})

test("agentRef's namespace prefix format matches the plugin name Claude Code actually registers", () => {
  const src = fs.readFileSync(SERVER_TS, "utf8")
  assert.match(
    src,
    /const agentRef = \(name: string\): string => `agentic-workflow:\$\{name\}`/,
    "agentRef's literal prefix drifted from \"agentic-workflow:\" — this must equal the plugin.json \"name\" field or every Task dispatch silently targets a nonexistent subagent_type",
  )
})
