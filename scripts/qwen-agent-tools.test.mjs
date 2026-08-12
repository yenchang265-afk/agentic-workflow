import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { dialectFor } from "../plugins/claude/hooks/src/dialect.mjs"

/**
 * Every tool a generated Qwen agent enumerates must be a tool Qwen Code
 * actually has.
 *
 * Qwen's `tools:` is an explicit enumeration, so an id that does not exist
 * fails SILENTLY — the agent is simply spawned without that capability, and
 * nothing anywhere reports it. That is how all 18 agents shipped granting
 * `grep_search`, which qwen-code does not have (its content search is
 * `search_file_content`): `workflow-review`, whose entire job is reading a
 * diff, ran with no content-search tool at all, and the thin proof-of-work
 * ledger that produced is exactly the shape `evidenceIssue` fails an honest
 * PASS for.
 *
 * The dialect is the oracle because it is already the single source of truth
 * the hooks classify by (`isReadTool`/`isWriteTool`/`isBashTool`) and it is
 * what `plugins/qwen/hooks/hooks.json`'s evidence matcher is derived from — so
 * a tool outside it could not be recorded as evidence even if it did exist.
 * MCP tools are exempt: they are named by this repo's own servers, not by the
 * host.
 */

const ROOT = path.join(import.meta.dirname, "..")
const QWEN_AGENTS = path.join(ROOT, "plugins", "qwen", "agents")

const qwen = dialectFor("qwen")
const KNOWN = new Set([...qwen.bash, ...qwen.write, ...qwen.read, ...qwen.spawn])

/** The `tools:` list of an agent file, or null when it declares none. */
const toolsOf = (file) => {
  const fm = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!fm) return null
  const block = fm[1].match(/^tools:\n((?:[ \t]+- .*\n?)+)/m)
  if (!block) return null
  return block[1]
    .split("\n")
    .map((line) => line.replace(/^[ \t]+-\s*/, "").trim())
    .filter(Boolean)
}

test("every generated Qwen agent enumerates only tools qwen-code has", () => {
  const offences = []
  let checked = 0
  for (const file of fs.readdirSync(QWEN_AGENTS).filter((f) => f.endsWith(".md")).sort()) {
    const tools = toolsOf(path.join(QWEN_AGENTS, file))
    if (tools === null) {
      offences.push(`${file}: no tools: enumeration`)
      continue
    }
    for (const tool of tools) {
      if (tool.startsWith("mcp__")) continue // this repo's own servers name these
      if (!KNOWN.has(tool)) offences.push(`${file}: "${tool}" is not a qwen-code tool (dialect.mjs knows ${[...KNOWN].sort().join(", ")})`)
    }
    checked++
  }
  assert.deepEqual(offences, [], `edit prompts/agents/<name>/qwen.yaml and re-run \`npm run gen:prompts\`:\n${offences.join("\n")}`)
  assert.ok(checked > 0, "no generated Qwen agent found — wrong path?")
})

test("the check-stage agents can still search file CONTENT, not just names", () => {
  // The regression that motivated this file was invisible because `glob` and
  // `read_file` survived: an agent with those two still looks equipped, and only
  // its evidence ledger comes out thin. Name the capability explicitly.
  for (const file of ["workflow-review.md", "workflow-verify.md", "workflow-build.md"]) {
    const tools = toolsOf(path.join(QWEN_AGENTS, file))
    assert.ok(tools?.includes("search_file_content"), `${file}: must grant search_file_content — its work is reading code`)
  }
})
