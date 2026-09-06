import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { EXPERIMENTAL_KINDS } from "../packages/core/dist/config.js"

/**
 * Every sitter is opt-in (`enabledWorkflowKinds`: a non-default kind runs only
 * with `enabled: true`), and the docs drifted from that twice — a quick-start
 * whose sitter section lacked the key configured a sitter that never runs.
 * Design 69 makes the drift a red test: every fenced ```json block in the doc
 * set whose `workflows.<opt-in kind>` section exists must carry `enabled`.
 * Reads `EXPERIMENTAL_KINDS` off core's built dist so a new kind is covered
 * the day it is added.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DOC_ROOTS = ["README.md", "README.zh-TW.md", "docs", "plugins/claude/README.md", "plugins/claude/README.zh-TW.md", "packages/hub/README.md", "packages/hub/README.zh-TW.md"]

const markdownFiles = (rel) => {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [rel]
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? markdownFiles(path.join(rel, e.name)) : e.name.endsWith(".md") ? [path.join(rel, e.name)] : []))
}

const jsonBlocks = (text) => [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[1])

test("every documented sitter section carries `enabled` — a knob-only section is inert", () => {
  const offenders = []
  let sections = 0
  for (const rel of DOC_ROOTS.flatMap(markdownFiles)) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
    for (const block of jsonBlocks(text)) {
      let parsed
      try {
        parsed = JSON.parse(block)
      } catch {
        continue // a fragment with placeholders is not a config example
      }
      const workflows = parsed && typeof parsed === "object" ? parsed.workflows : undefined
      if (!workflows || typeof workflows !== "object") continue
      for (const kind of EXPERIMENTAL_KINDS) {
        const section = workflows[kind]
        if (!section || typeof section !== "object") continue
        sections++
        if (!("enabled" in section)) offenders.push(`${rel}: workflows.${kind} without enabled`)
      }
    }
  }
  assert.ok(sections > 5, `expected the docs to carry sitter examples, found ${sections}`)
  assert.deepEqual(offenders, [])
})
