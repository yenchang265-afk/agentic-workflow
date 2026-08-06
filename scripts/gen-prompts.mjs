#!/usr/bin/env node
/**
 * Generate the per-host agent prompt files from their single source.
 *
 * Source of truth: prompts/agents/<name>/{body.md, opencode.yaml, claude.yaml}
 * Output (checked in): plugins/opencode/agents/<name>.md and
 * plugins/claude/agents/<name>.md — each is the host's frontmatter (verbatim,
 * wrapped in ---) plus body.md rendered for that host.
 *
 * body.md may contain host-conditional blocks, each marker on its own line:
 *   {{#host opencode}}     ... {{/host}}
 *   {{#host claude}}       ... {{/host}}
 *   {{#host claude|qwen}}  ... {{/host}}
 * A block is kept (markers stripped) when its host is named, dropped otherwise.
 * The `|` list matters: most prose that is "not opencode" is identical on Claude
 * Code and Qwen Code, and duplicating it into per-host twins is exactly how the
 * two would drift. Name both hosts on one block; split only where they genuinely
 * differ.
 *
 * Run `node scripts/gen-prompts.mjs` after editing a source; CI fails when the
 * generated files drift from their sources (`git diff --exit-code`).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "prompts", "agents")
const WORKFLOWS = path.join(ROOT, "packages", "core", "workflows")
const HOSTS = [
  { host: "opencode", frontmatter: "opencode.yaml", outDir: path.join(ROOT, "plugins", "opencode", "agents") },
  { host: "claude", frontmatter: "claude.yaml", outDir: path.join(ROOT, "plugins", "claude", "agents") },
  { host: "qwen", frontmatter: "qwen.yaml", outDir: path.join(ROOT, "plugins", "qwen", "agents") },
]

/**
 * The bash allowlist each stage agent may run, sourced from the workflow manifests
 * (`workflows/<kind>/workflow.json`) — the single source of truth. An agent's globs are
 * its stage's `bashAllowlist` plus every `platformAllowlist` value (static
 * frontmatter can't switch on platform, so all platforms are allowed and the
 * stage prompt uses the configured one). Same agent in two manifests must declare
 * the identical allowlist. Keyed by agent name; only agents that declare one appear.
 */
const agentAllowlists = () => {
  const byAgent = new Map()
  for (const kind of fs.readdirSync(WORKFLOWS).sort()) {
    const manifestPath = path.join(WORKFLOWS, kind, "workflow.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    for (const stage of manifest.stages ?? []) {
      const globs = [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]
      if (globs.length === 0) continue
      const existing = byAgent.get(stage.agent)
      if (existing && JSON.stringify(existing) !== JSON.stringify(globs)) {
        throw new Error(
          `agent "${stage.agent}" has conflicting bash allowlists across manifests — reconcile them in workflows/*/workflow.json`,
        )
      }
      byAgent.set(stage.agent, globs)
    }
  }
  return byAgent
}

const ALLOWLISTS = agentAllowlists()

/**
 * The MCP tool names each agent may call, from `platformTools` in the manifests.
 * Same single-source rule as the bash allowlist above, and for the same reason:
 * hand-authoring `tools:` per host is how a persona drifts from the manifest that
 * governs it. Keyed by agent name; only agents that declare tools appear.
 */
const agentPlatformTools = () => {
  const byAgent = new Map()
  for (const kind of fs.readdirSync(WORKFLOWS).sort()) {
    const manifestPath = path.join(WORKFLOWS, kind, "workflow.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    for (const stage of manifest.stages ?? []) {
      const tools = Object.values(stage.platformTools ?? {}).flat()
      if (tools.length === 0) continue
      const existing = byAgent.get(stage.agent)
      if (existing && JSON.stringify(existing) !== JSON.stringify(tools)) {
        throw new Error(
          `agent "${stage.agent}" has conflicting platformTools across manifests — reconcile them in workflows/*/workflow.json`,
        )
      }
      byAgent.set(stage.agent, tools)
    }
  }
  return byAgent
}

const PLATFORM_TOOLS = agentPlatformTools()

/**
 * The MCP server name the Azure DevOps tools are addressed under. A CONSTANT,
 * not a config knob: these names are baked into generated files, and a
 * user-specific server name would make those files user-specific too, breaking
 * the `gen:prompts && git diff --exit-code` drift gate. Mirrors
 * `ADO_MCP_SERVER_NAME` in packages/core/src/source/ado-tools.ts.
 */
const ADO_MCP_SERVER_NAME = "azure-devops"

/**
 * Expand an `{{adoTools}}` marker in an agent's frontmatter into that agent's
 * Azure DevOps MCP tool names, in the host's own list syntax:
 *
 * - Claude/Qwen `tools:` — a comma list appended inline (Claude) or one `- item`
 *   per line preserving the marker's indentation (Qwen).
 * - OpenCode `tools:` — a `<name>: true` map entry per tool.
 *
 * A marker on an agent with no platformTools expands to nothing, so a persona
 * that stops touching ADO cleans itself up.
 */
const expandAdoTools = (frontmatter, agent, host) => {
  if (!frontmatter.includes("{{adoTools}}")) return frontmatter
  const tools = (PLATFORM_TOOLS.get(agent) ?? []).map((t) => `mcp__${ADO_MCP_SERVER_NAME}__${t}`)
  if (host === "claude") {
    // Inline comma list; drop a dangling separator when the agent has no tools.
    return frontmatter
      .replace(/,\s*\{\{adoTools\}\}/, tools.length ? `, ${tools.join(", ")}` : "")
      .replace(/\{\{adoTools\}\}/, tools.join(", "))
  }
  const marker = /^([ \t]*)-?[ \t]*\{\{adoTools\}\}[ \t]*$/m
  const m = marker.exec(frontmatter)
  if (!m) return frontmatter.replace(/\{\{adoTools\}\}/, tools.join(", "))
  const indent = m[1]
  const lines =
    host === "opencode"
      ? tools.map((t) => `${indent}${t}: true`).join("\n")
      : tools.map((t) => `${indent}- ${t}`).join("\n")
  // Function replacement so a `$` in a tool name is spliced literally.
  return lines ? frontmatter.replace(marker, () => lines) : frontmatter.replace(new RegExp(`${marker.source}\n?`, "m"), "")
}

/**
 * The subagent each per-stage OpenCode command fires, sourced from the workflow
 * manifests (`workflows/<kind>/workflow.json` — the single source): `command` name →
 * `stage.agent`. This is what makes the agent-per-stage binding manifest-driven
 * instead of a hand-copied `agent:` frontmatter line. A command shared across
 * kinds (e.g. `verify`) must bind the identical agent everywhere. Keyed by command
 * name; entry commands and non-stage commands (which no manifest names) are absent.
 */
const commandAgents = () => {
  const byCommand = new Map()
  for (const kind of fs.readdirSync(WORKFLOWS).sort()) {
    const manifestPath = path.join(WORKFLOWS, kind, "workflow.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    for (const stage of manifest.stages ?? []) {
      if (!stage.command || !stage.agent) continue
      const existing = byCommand.get(stage.command)
      if (existing && existing !== stage.agent) {
        throw new Error(
          `command "${stage.command}" binds different agents across manifests ("${existing}" vs "${stage.agent}") — reconcile them in workflows/*/workflow.json`,
        )
      }
      byCommand.set(stage.command, stage.agent)
    }
  }
  return byCommand
}

const COMMAND_AGENTS = commandAgents()

/**
 * Rewrite (or insert) a command file's frontmatter `agent:` line to the
 * manifest-declared agent, leaving the hand-authored body and every other
 * frontmatter key untouched. Byte-identical today (the hand-copies already agree),
 * so CI's `git diff --exit-code` stays green while proving the two are in sync.
 */
const setCommandAgent = (src, agent, command) => {
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(src)
  if (!fmMatch) throw new Error(`command "${command}" has no frontmatter block`)
  let fm = fmMatch[1]
  fm = /^agent:.*$/m.test(fm) ? fm.replace(/^agent:.*$/m, `agent: ${agent}`) : `${fm}\nagent: ${agent}`
  return `---\n${fm}\n---\n${src.slice(fmMatch[0].length)}`
}

/**
 * Expand a `# {{allowlist}}` marker line in an OpenCode frontmatter's
 * `permission.bash` map into `"<glob>": allow` lines from the manifest, preserving
 * the marker's indentation. This is what single-sources the allowlist: the yaml
 * declares only the `"*": deny` sentinel and the marker; the globs live in workflow.json.
 */
const expandAllowlist = (frontmatter, agent) => {
  // Match the whole marker line (any surrounding comment text), capturing its
  // indentation; the line is replaced wholesale so inline notes don't leak to output.
  const marker = /^([ \t]*)#.*\{\{allowlist\}\}.*$/m
  const m = marker.exec(frontmatter)
  if (!m) return frontmatter
  const globs = ALLOWLISTS.get(agent)
  if (!globs) throw new Error(`agent "${agent}" uses {{allowlist}} but declares no bashAllowlist in any workflow.json`)
  const indent = m[1]
  const lines = globs.map((g) => `${indent}${JSON.stringify(g)}: allow`).join("\n")
  // Function replacement, not a string: a glob containing `$` (e.g. `$HOME`) must
  // be spliced literally, not interpreted as a `String.replace` `$`-pattern.
  return frontmatter.replace(marker, () => lines)
}

/**
 * Per-host substitutions for host-specific words that appear MID-SENTENCE.
 * A `{{#host}}` block is right for a paragraph; for a tool name inside a clause
 * it would shred the prose into per-host fragments nobody can read or keep in
 * step. Applied after the host blocks, and an unrendered `{{` still throws — so
 * a typo'd token fails the build instead of shipping a literal `{{spawnTool}}`.
 *
 * `modelClause` is empty on Qwen because its `agent` tool takes no per-call
 * model (the model is baked into the installed agent file at install time);
 * that emptiness is a declared value, not a missing entry.
 */
const TOKENS = {
  opencode: {
    hostName: "OpenCode",
    spawnTool: "subtask command",
    // A TOOL NAME, not prose. This read "a follow-up question" for as long as
    // OpenCode had no structured ask — every `{{askTool}}` sentence then told
    // the model to type a question into the chat, which is why the `new`
    // interview never opened a question window on this host. OpenCode ships the
    // `question` tool as of @opencode-ai/plugin 1.18.5 (`PermissionConfig.question`,
    // `QuestionRequest`/`QuestionInfo`, and the TUI's question dialog), and its
    // payload is the same shape as the other two hosts' — so do not "restore"
    // the prose form: it silently disables the window rather than failing.
    askTool: "`question`",
    modelClause: "",
  },
  claude: {
    hostName: "Claude Code",
    spawnTool: "Task tool",
    askTool: "AskUserQuestion",
    // A DECLARATION, not an instruction. The PreToolUse stamp
    // (plugins/claude/hooks/src/stamp-spawn-model.entry.mjs) rewrites the spawn
    // call's `model` before the tool runs, so asking the model to pass it is
    // both unnecessary and — as the stageModels regression showed — unreliable.
    // The clause stays so a transcript still states which model was bound: if
    // the hook ever stops firing, that statement stops matching the model the
    // subagent actually ran on, which is the only signal such a regression has.
    modelClause: " (its `model` is already pinned from the response's `model` field when present)",
  },
  qwen: {
    hostName: "Qwen Code",
    spawnTool: "`agent` tool",
    askTool: "`ask_user_question`",
    modelClause: "",
  },
}

/** Substitute the host's inline tokens. Unknown `{{...}}` is left for the caller's guard. */
const substitute = (text, host) =>
  text.replace(/\{\{([a-zA-Z]+)\}\}/g, (whole, key) => (key in TOKENS[host] ? TOKENS[host][key] : whole))

const OPEN = /^\{\{#host ([a-z]+(?:\|[a-z]+)*)\}\}\s*$/
const CLOSE = /^\{\{\/host\}\}\s*$/

/** Render a body for one host: keep matching blocks (markers stripped), drop the rest. */
const render = (body, host) => {
  const out = []
  let keeping = true
  let inBlock = false
  for (const line of body.split("\n")) {
    const open = OPEN.exec(line)
    if (open) {
      if (inBlock) throw new Error(`nested {{#host}} block (at "${line}")`)
      const named = open[1].split("|")
      const unknown = named.filter((h) => !HOSTS.some((k) => k.host === h))
      // A typo'd host name is not a no-op: the block is silently dropped from
      // EVERY rendering, so the prose vanishes with no error anywhere.
      if (unknown.length) throw new Error(`{{#host ${open[1]}}} names unknown host(s): ${unknown.join(", ")}`)
      inBlock = true
      keeping = named.includes(host)
      continue
    }
    if (CLOSE.test(line)) {
      if (!inBlock) throw new Error("{{/host}} without an open block")
      inBlock = false
      keeping = true
      continue
    }
    if (keeping) out.push(line)
  }
  if (inBlock) throw new Error("unclosed {{#host}} block")
  // Dropped blocks can leave runs of blank lines — collapse to one blank line.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n")
}

let wrote = 0
for (const name of fs.readdirSync(SRC).sort()) {
  const dir = path.join(SRC, name)
  if (!fs.statSync(dir).isDirectory()) continue
  const body = fs.readFileSync(path.join(dir, "body.md"), "utf8")
  for (const { host, frontmatter, outDir } of HOSTS) {
    const raw = fs.readFileSync(path.join(dir, frontmatter), "utf8").replace(/\n+$/, "")
    // OpenCode enforces the bash allowlist via agent-frontmatter permissions;
    // expand the manifest-sourced globs into it (no-op when there's no marker).
    // OpenCode enforces the bash allowlist via frontmatter permissions; every
    // host declares its MCP tool list there. Both are manifest-sourced — no-ops
    // when the yaml carries no marker.
    const fm = expandAdoTools(host === "opencode" ? expandAllowlist(raw, name) : raw, name, host)
    if (fm.includes("{{")) throw new Error(`${name}/${host}: unrendered frontmatter marker survived`)
    const rendered = substitute(render(body, host), host)
    if (rendered.includes("{{")) throw new Error(`${name}/${host}: unrendered marker survived`)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, `${name}.md`), `---\n${fm}\n---\n\n${rendered}`)
    wrote++
  }
}
console.log(`gen-prompts: wrote ${wrote} files from ${SRC}`)

/**
 * The per-verb command halves (prompts/verbs/<name>.md → plugins/<host>/verbs/).
 * Both prompt-injecting hosts — Claude Code and Qwen Code — receive the invoked
 * verb's block from a UserPromptSubmit hook, and the two texts differ only in
 * the spawn/ask tool names. Hand-maintaining two copies of a 200-line procedure
 * is exactly the drift AGENTS.md warns about: a verb that loses its block does
 * not error, it silently falls back to no instructions at all.
 *
 * OpenCode is absent on purpose — it slices its own rendered command prompt
 * (plugins/opencode/src/command-slice.ts) and has no verbs/ directory.
 */
const VERBS_SRC = path.join(ROOT, "prompts", "verbs")
const VERB_HOSTS = ["claude", "qwen"]
let verbs = 0
if (fs.existsSync(VERBS_SRC)) {
  for (const file of fs.readdirSync(VERBS_SRC).sort()) {
    if (!file.endsWith(".md")) continue
    const body = fs.readFileSync(path.join(VERBS_SRC, file), "utf8")
    for (const host of VERB_HOSTS) {
      const rendered = substitute(render(body, host), host)
      if (rendered.includes("{{")) throw new Error(`verbs/${file}/${host}: unrendered marker survived`)
      const outDir = path.join(ROOT, "plugins", host, "verbs")
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, file), rendered)
      verbs++
    }
  }
}
console.log(`gen-prompts: wrote ${verbs} verb files from ${VERBS_SRC}`)

/**
 * The driving-protocol skill (prompts/skills/<name>/SKILL.md → plugins/<host>/skills/).
 *
 * prompts/README.md says the workflow-orchestration skills are NOT generated
 * because OpenCode's in-process driver and the MCP pull protocol are genuinely
 * different documents — still true, and why `skills/workflow-orchestration/`
 * stays hand-authored for OpenCode. But Claude Code and Qwen Code run the SAME
 * protocol and differ only in tool names, so hand-maintaining a second 290-line
 * copy would be pure drift surface. Same rule as the verbs: one source, host
 * tokens for the words, host blocks for the paragraphs.
 */
const SKILLS_SRC = path.join(ROOT, "prompts", "skills")
let skills = 0
if (fs.existsSync(SKILLS_SRC)) {
  for (const name of fs.readdirSync(SKILLS_SRC).sort()) {
    const file = path.join(SKILLS_SRC, name, "SKILL.md")
    if (!fs.existsSync(file)) continue
    const body = fs.readFileSync(file, "utf8")
    for (const host of VERB_HOSTS) {
      const rendered = substitute(render(body, host), host)
      if (rendered.includes("{{")) throw new Error(`skills/${name}/${host}: unrendered marker survived`)
      const outDir = path.join(ROOT, "plugins", host, "skills", name)
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, "SKILL.md"), rendered)
      skills++
    }
  }
}
console.log(`gen-prompts: wrote ${skills} skill files from ${SKILLS_SRC}`)

// Single-source the OpenCode per-stage command `agent:` from the manifests. The
// command bodies stay hand-authored; only the agent binding is normalized, so a
// new/changed manifest agent regenerates here and CI drift catches a hand-edit.
const CMD_DIR = path.join(ROOT, "plugins", "opencode", "commands")
let cmds = 0
for (const file of fs.readdirSync(CMD_DIR).sort()) {
  if (!file.endsWith(".md")) continue
  const agent = COMMAND_AGENTS.get(file.slice(0, -3))
  if (!agent) continue // entry commands + non-stage commands keep their hand-authored frontmatter
  const p = path.join(CMD_DIR, file)
  const src = fs.readFileSync(p, "utf8")
  const normalized = setCommandAgent(src, agent, file.slice(0, -3))
  if (normalized !== src) fs.writeFileSync(p, normalized)
  cmds++
}
console.log(`gen-prompts: normalized ${cmds} command agents from ${WORKFLOWS}`)
