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
 *   {{#host opencode}} ... {{/host}}
 *   {{#host claude}}   ... {{/host}}
 * A block is kept (markers stripped) when its host matches, dropped otherwise.
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

const OPEN = /^\{\{#host ([a-z]+)\}\}\s*$/
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
      inBlock = true
      keeping = open[1] === host
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
    const fm = host === "opencode" ? expandAllowlist(raw, name) : raw
    const rendered = render(body, host)
    if (rendered.includes("{{")) throw new Error(`${name}/${host}: unrendered marker survived`)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, `${name}.md`), `---\n${fm}\n---\n\n${rendered}`)
    wrote++
  }
}
console.log(`gen-prompts: wrote ${wrote} files from ${SRC}`)

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
