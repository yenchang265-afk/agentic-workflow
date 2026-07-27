import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * Coverage lint for the spawn-model BINDING.
 *
 * This file used to assert that every spawn instruction in the host's prose
 * named the `model` field, because the model's cooperation was the only channel
 * — and a note that named `agent` without `model` was exactly how
 * `workflows.<kind>.stageModels` got dropped at every hop while every stage ran
 * the host default.
 *
 * That channel is gone. The PreToolUse stamp
 * (hooks/src/stamp-spawn-model.entry.mjs) rewrites the spawn call's `model`
 * before the tool runs, and ../spawn-model-stamp.test.mjs asserts the mechanism
 * directly. So the question this file answers changed with it: not "does the
 * prose ask for a model?" but **"is every agent the prose tells anyone to spawn
 * actually reachable by the mechanism?"** An agent the stamp cannot match is one
 * that silently runs the host default — the same defect, one layer down.
 *
 * The prose still STATES the bound model (see the `spawnModelNote` docstring in
 * mcp-server/src/server.ts); that is deliberate and is the only way a hook
 * regression stays visible in a transcript. It is no longer an instruction, so
 * it is no longer linted as one.
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
 * Spawns that are not stage runs: no StageDef for modelFor() to resolve and no
 * MCP response to carry a value. Their model comes from the `agentModels` knob,
 * which the PreToolUse stamp reads off the config layers directly — so their
 * prose names no model and never needed to.
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

/**
 * The gate the stamp applies to `subagent_type`, mirrored from
 * hooks/src/stamp-spawn-model.entry.mjs. Anything failing it is left on the host
 * default, by design — that is what stops `agentModels: {"general-purpose": …}`
 * from rebinding a host built-in.
 */
const STAMPABLE = /^workflow-[a-z0-9-]+$/

test("every agent the prose tells anyone to spawn is one the stamp can bind", () => {
  const named = new Set()
  for (const unit of selected()) {
    for (const [, agent] of unit.text.matchAll(/`(workflow-[a-z0-9-]+)`/g)) named.add(agent)
  }
  assert.ok(named.size >= 3, `expected the prose to name concrete agents; got ${[...named].join(", ")}`)
  for (const agent of named) {
    assert.match(
      agent,
      STAMPABLE,
      `the prose tells the orchestrator to spawn "${agent}", which the spawn-model stamp cannot match — ` +
        "that spawn would silently run the host default no matter what stageModels/agentModels say",
    )
  }
})

// The other half of the same guarantee: not just the agents the prose happens to
// name, but every agent this plugin actually ships. An agent file added under a
// different naming convention would be unreachable by the binding while looking
// perfectly healthy.
test("every agent this plugin ships is reachable by the stamp's subagent_type gate", () => {
  const agents = fs
    .readdirSync(path.join(ROOT, "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
  assert.ok(agents.length >= 5, `expected the shipped agents to be found; got ${agents.length}`)
  for (const agent of agents) {
    assert.match(agent, STAMPABLE, `plugins/claude/agents/${agent}.md cannot be bound by the spawn-model stamp`)
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
