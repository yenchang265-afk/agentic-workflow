import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ConfigSchema } from "@agentic-workflow/core/config"
import type { KindBoardInfo } from "../shared/api.js"
import { BY_SOURCE, STRUCTURED_KEYS, lintWorkflowKnobs } from "./knobs.js"

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
  board("review-sitter", "pull-request"),
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

test("scannerCommand lints as a dependency-scan string knob", () => {
  assert.deepEqual(lint({ "dep-sitter": { scannerCommand: "corp-scan --json {{target}}" } }), [])

  const wrongSource = lint({ engineering: { scannerCommand: "corp-scan" } })
  assert.equal(wrongSource.length, 1)
  assert.match(wrongSource[0]?.message ?? "", /only applies to dependency-scan kinds/)

  const wrongType = lint({ "dep-sitter": { scannerCommand: 7 } })
  assert.equal(wrongType.length, 1)
  assert.match(wrongType[0]?.message ?? "", /read only when it is a string/)
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
    // `maxDiffLines` rides along here on purpose: core's schema types it, so a
    // bad value fails the load loudly and "silently ignored" would be a lie.
    "pr-sitter": { enabled: true, codePlatform: "ado", query: "is:open", trigger: { type: "cron", schedule: "0 * * * *" } },
    "review-sitter": { enabled: true, maxDiffLines: 500 },
    "dep-sitter": { severityFloor: "high", includeOutdated: true, ecosystem: "npm" },
    "main-sitter": { branch: "main" },
  })
  assert.deepEqual(w, [])
})

test("every schema-validated per-kind knob lints clean — no false 'unknown knob' warnings", () => {
  // The regression this pins: STRUCTURED_KEYS drifted to a three-entry subset
  // of core's `workflows.<kind>` schema, so the Config tab told operators that
  // real, working settings (`stageFanout`, `stageChecks`, …) were "unknown …
  // silently ignored".
  const w = lint({
    engineering: {
      prBase: "release/2.4",
      stageContext: { build: { plan: 24000 } },
      stageFanout: { review: "axis" },
      stageConcurrency: { review: 3 },
      stageChecks: { verify: [{ name: "tests", command: "npm test" }] },
      discoverChecks: true,
      planVisualization: true,
    },
  })
  assert.deepEqual(w, [])
})

test("drift alarm: every STRUCTURED_KEY really is validated by core's schema", () => {
  // A key that belongs in the list is exactly one whose bad value FAILS
  // `ConfigSchema` — `workflows.<kind>` is a looseObject, so an undeclared key
  // with the same bad value passes straight through. The control key proves the
  // probe discriminates.
  const parses = (section: Record<string, unknown>): boolean => ConfigSchema.safeParse({ workflows: { engineering: section } }).success
  assert.ok(parses({ ["not-a-real-knob"]: 7 }), "the looseObject must pass an undeclared key — otherwise this probe proves nothing")
  for (const key of STRUCTURED_KEYS) {
    // `maxDiffLines` is a number, so probe it with a string; everything else
    // rejects a bare number.
    const bad = key === "maxDiffLines" ? "not-a-number" : 7
    assert.equal(parses({ [key]: bad }), false, `"${key}" is in STRUCTURED_KEYS but core's schema does not validate it — remove it, or the lint goes blind to its typos`)
  }
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
  assert.ok(found.size >= 6, `extracted only ${found.size} knob reads from ${orchestrate} — the regex has rotted, not the registry`)
  assert.deepEqual(
    [...found].sort(),
    [...registered].sort(),
    "orchestrate.ts and hub's knob registry disagree — update knobs.ts (or promote it into core next to orchestrate)",
  )
})
