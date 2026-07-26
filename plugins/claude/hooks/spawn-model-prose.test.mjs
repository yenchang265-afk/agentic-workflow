import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * The Claude host cannot spawn: the MCP server returns a `model` field and a note,
 * and the orchestrating model must voluntarily set the Task tool's `model`. The
 * server side of that contract is linted in mcp-server/src/server.test.ts. This is
 * the other side — the prose the orchestrator reads BEFORE any tool result exists,
 * which is what it plans the turn from. A spawn instruction that names `agent`
 * without `model` is exactly how `workflows.<kind>.stageModels` was silently
 * dropped at every hop while every stage ran the host default.
 *
 * It lives here because `npm run test:hooks` (`node --test hooks/*.test.mjs`) is
 * the only runner that covers this plugin's markdown, and verb-slice.test.mjs
 * already sets the precedent of asserting content contracts over commands/ and
 * verbs/ from this directory.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Files whose spawn prose is linted. Explicit, not a glob: a new command should
 * have to opt in consciously rather than inherit the contract silently.
 */
const FILES = [
  "commands/engineering.md",
  "commands/pr-sitter.md",
  "commands/review-sitter.md",
  "commands/dep-sitter.md",
  "commands/main-sitter.md",
  "verbs/engineering.md",
  "skills/workflow-orchestration/SKILL.md",
]

/**
 * Sections that talk about spawning without instructing one: the stage-marker
 * bookkeeping rule, the per-kind stage rosters and kind-agnostic sequence prose,
 * the host-difference notes, and the anti-pattern list (a spawn phrased as a
 * thing NOT to do). Matched on the `##` heading's opening words.
 */
const SKIPPED_SECTIONS = ["Between-stage bookkeeping", "Workflow kinds", "What is different", "Red flags"]

/**
 * Spawns with no model source at all: they are not stage runs, so there is no
 * StageDef for modelFor() to resolve and no MCP response to carry a value. Their
 * model comes from the `agentModels` knob, injected by the hook at spawn time
 * (see verb-slice.mjs) rather than named in static prose.
 */
const NO_MODEL_SOURCE = [
  "to write the draft file(s)", // verbs/engineering.md `new` step 4 — pre-loop drafting
  "in **`retask` mode**", // verbs/engineering.md `retask` step 4 — same
]

/** Drop fenced blocks: the pipeline ASCII diagram and the JSON config samples. */
const stripFences = (body) => {
  let fenced = false
  return body.split("\n").filter((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return false
    }
    return !fenced
  })
}

/**
 * Markdown wraps at ~80 columns, so one instruction spans three or four lines —
 * line-by-line matching would both miss instructions and misfire on their tails.
 * A unit starts at a blank line or a list bullet and carries the `##` section it
 * sits under.
 */
const units = (body) => {
  const out = []
  let current = null
  let section = ""
  for (const line of stripFences(body)) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      section = heading[1]
      current = null
      continue
    }
    if (!line.trim()) {
      current = null
      continue
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line) || !current) {
      current = { section, text: line.trim() }
      out.push(current)
      continue
    }
    current.text += ` ${line.trim()}`
  }
  return out
}

/** A real spawn instruction: it tells the reader to spawn a specific subagent. */
const isSpawnInstruction = (unit) =>
  /\bspawn/i.test(unit.text) &&
  (/`agent` field/.test(unit.text) ||
    /response's `agent`/.test(unit.text) ||
    /spawn\w*\s+(the\s+)?(\*\*)?`?workflow-/i.test(unit.text) ||
    /stage subagents?\b/i.test(unit.text)) &&
  !SKIPPED_SECTIONS.some((s) => unit.section.startsWith(s)) &&
  !NO_MODEL_SOURCE.some((s) => unit.text.includes(s))

const selected = () =>
  FILES.flatMap((file) =>
    units(fs.readFileSync(path.join(ROOT, file), "utf8"))
      .filter(isSpawnInstruction)
      .map((unit) => ({ ...unit, file })),
  )

test("every spawn instruction in the host's prose names the `model` field, not just `agent`", () => {
  for (const unit of selected()) {
    assert.match(
      unit.text,
      /`model`/,
      `${unit.file} tells the orchestrator to spawn without naming the model — ` +
        `the configured stageModels model is dropped:\n  ${unit.text}`,
    )
  }
})

// Without this the lint above is one regex regression away from selecting nothing
// and passing forever — the failure mode that makes a source lint worse than none.
test("the spawn-prose lint actually selects instructions from every file it claims to cover", () => {
  const found = selected()
  assert.ok(found.length >= 12, `expected the spawn instructions to be found; got ${found.length}`)
  for (const file of FILES) {
    assert.ok(
      found.some((u) => u.file === file),
      `${file} contributed no spawn instruction — the selector no longer matches it, so the file is unlinted`,
    )
  }
})

// The Class-B allowlist is a recorded decision, not an accident of regex: assert
// the sites it names still exist, so a rewrite that gives them a model source (or
// deletes them) forces the list to be revisited.
test("the no-model-source allowlist still matches real prose", () => {
  const verbs = fs.readFileSync(path.join(ROOT, "verbs", "engineering.md"), "utf8")
  for (const needle of NO_MODEL_SOURCE) {
    assert.ok(verbs.includes(needle), `the allowlist names "${needle}", which no longer appears in verbs/engineering.md`)
  }
})
