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
const HOSTS = [
  { host: "opencode", frontmatter: "opencode.yaml", outDir: path.join(ROOT, "plugins", "opencode", "agents") },
  { host: "claude", frontmatter: "claude.yaml", outDir: path.join(ROOT, "plugins", "claude", "agents") },
]

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
    const fm = fs.readFileSync(path.join(dir, frontmatter), "utf8").replace(/\n+$/, "")
    const rendered = render(body, host)
    if (rendered.includes("{{")) throw new Error(`${name}/${host}: unrendered marker survived`)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, `${name}.md`), `---\n${fm}\n---\n\n${rendered}`)
    wrote++
  }
}
console.log(`gen-prompts: wrote ${wrote} files from ${SRC}`)
