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
const LOOPS = path.join(ROOT, "packages", "core", "loops")
const HOSTS = [
  { host: "opencode", frontmatter: "opencode.yaml", outDir: path.join(ROOT, "plugins", "opencode", "agents") },
  { host: "claude", frontmatter: "claude.yaml", outDir: path.join(ROOT, "plugins", "claude", "agents") },
]

/**
 * The bash allowlist each stage agent may run, sourced from the loop manifests
 * (`loops/<kind>/loop.json`) — the single source of truth. An agent's globs are
 * its stage's `bashAllowlist` plus every `platformAllowlist` value (static
 * frontmatter can't switch on platform, so all platforms are allowed and the
 * stage prompt uses the configured one). Same agent in two manifests must declare
 * the identical allowlist. Keyed by agent name; only agents that declare one appear.
 */
const agentAllowlists = () => {
  const byAgent = new Map()
  for (const kind of fs.readdirSync(LOOPS).sort()) {
    const manifestPath = path.join(LOOPS, kind, "loop.json")
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    for (const stage of manifest.stages ?? []) {
      const globs = [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]
      if (globs.length === 0) continue
      const existing = byAgent.get(stage.agent)
      if (existing && JSON.stringify(existing) !== JSON.stringify(globs)) {
        throw new Error(
          `agent "${stage.agent}" has conflicting bash allowlists across manifests — reconcile them in loops/*/loop.json`,
        )
      }
      byAgent.set(stage.agent, globs)
    }
  }
  return byAgent
}

const ALLOWLISTS = agentAllowlists()

/**
 * Expand a `# {{allowlist}}` marker line in an OpenCode frontmatter's
 * `permission.bash` map into `"<glob>": allow` lines from the manifest, preserving
 * the marker's indentation. This is what single-sources the allowlist: the yaml
 * declares only the `"*": deny` sentinel and the marker; the globs live in loop.json.
 */
const expandAllowlist = (frontmatter, agent) => {
  // Match the whole marker line (any surrounding comment text), capturing its
  // indentation; the line is replaced wholesale so inline notes don't leak to output.
  const marker = /^([ \t]*)#.*\{\{allowlist\}\}.*$/m
  const m = marker.exec(frontmatter)
  if (!m) return frontmatter
  const globs = ALLOWLISTS.get(agent)
  if (!globs) throw new Error(`agent "${agent}" uses {{allowlist}} but declares no bashAllowlist in any loop.json`)
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
