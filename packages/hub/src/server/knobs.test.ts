import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { KindBoardInfo } from "../shared/api.js"
import { BY_SOURCE, lintWorkflowKnobs } from "./knobs.js"

const board = (kind: string, sourceType: KindBoardInfo["sourceType"]): KindBoardInfo => ({
  kind,
  description: "",
  sourceType,
  statuses: [],
  gateStatuses: [],
  pools: [],
})

const BOARDS: readonly KindBoardInfo[] = [
  board("engineering", "backlog"),
  board("pr-sitter", "pull-request"),
  board("dep-sitter", "dependency-scan"),
  board("main-sitter", "ci-runs"),
]

const lint = (workflows: unknown) => lintWorkflowKnobs(workflows, BOARDS)

test("a typo is caught with a suggestion — orchestrate would ignore it silently", () => {
  const w = lint({ "dep-sitter": { severityfloor: "high" } })
  assert.equal(w.length, 1)
  assert.equal(w[0]?.path, "workflows.dep-sitter.severityfloor")
  assert.equal(w[0]?.suggestion, "severityFloor")
  assert.match(w[0]?.message ?? "", /silently ignored/)
})

test("a wrong type is caught, naming where orchestrate reads it", () => {
  const w = lint({ "dep-sitter": { severityFloor: 7 } })
  assert.equal(w.length, 1)
  assert.match(w[0]?.message ?? "", /read only when it is a string/)
  assert.match(w[0]?.message ?? "", /orchestrate\.ts:124/)
})

test("a knob on the wrong source is named as such, not merely 'unknown'", () => {
  // `query` is real — for pull-request kinds. On a backlog kind it looks right and
  // never fires, which is exactly the failure worth explaining.
  const w = lint({ engineering: { query: "is:open" } })
  assert.equal(w.length, 1)
  assert.match(w[0]?.message ?? "", /only applies to pull-request kinds/)
})

test("a section for a kind that isn't installed is reported as inert", () => {
  const w = lint({ "ghost-sitter": { enabled: true } })
  assert.equal(w.length, 1)
  assert.match(w[0]?.message ?? "", /no workflow kind "ghost-sitter" is installed/)
})

test("valid knobs, universal keys, and the structured trigger/stageModels produce no warnings", () => {
  const w = lint({
    engineering: { enabled: true, stageModels: { build: "anthropic/claude-sonnet-4-5" } },
    "pr-sitter": { enabled: true, codePlatform: "ado", query: "is:open", trigger: { type: "cron", schedule: "0 * * * *" } },
    "dep-sitter": { severityFloor: "high", includeOutdated: true, ecosystem: "npm" },
    "main-sitter": { branch: "main" },
  })
  assert.deepEqual(w, [])
})

test("linting is total — a non-object workflows section or member never throws", () => {
  assert.deepEqual(lint(undefined), [])
  assert.deepEqual(lint("nonsense"), [])
  assert.deepEqual(lint({ engineering: "nonsense" }), [])
})

/**
 * The drift alarm. This registry duplicates knowledge that lives in
 * orchestrate.ts — accepted deliberately (see knobs.ts), but only because drift
 * shows up here as a red test rather than as a wrong warning in the UI.
 *
 * Reads orchestrate's source and extracts every positional knob read. Both
 * spellings it uses today, optional chaining included:
 *   config.workflows[kind]?.["query"]      knobs["severityFloor"]
 */
test("drift alarm: the registry matches the knobs orchestrate.ts actually reads", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const orchestrate = path.resolve(here, "../../../core/src/workflow/orchestrate.ts")
  const src = fs.readFileSync(orchestrate, "utf8")

  const found = new Set<string>()
  for (const m of src.matchAll(/(?:knobs|config\.workflows\[kind\])\??\.?\[["']([A-Za-z]+)["']\]/g)) {
    if (m[1]) found.add(m[1])
  }

  const registered = new Set(Object.values(BY_SOURCE).flatMap((defs) => Object.keys(defs)))

  // A rotted regex would extract nothing (or too little) and "pass" by matching
  // an empty registry — so pin the count as well as the contents.
  assert.ok(found.size >= 5, `extracted only ${found.size} knob reads from ${orchestrate} — the regex has rotted, not the registry`)
  assert.deepEqual(
    [...found].sort(),
    [...registered].sort(),
    "orchestrate.ts and hub's knob registry disagree — update knobs.ts (or promote it into core next to orchestrate)",
  )
})
