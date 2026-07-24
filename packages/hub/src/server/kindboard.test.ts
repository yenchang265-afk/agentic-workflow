import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { parseConfig } from "@agentic-workflow/core/config"
import { kindBoards, unionGates, unionStatuses } from "./kindboard.js"

// The shipped workflow kinds are the fixture — boards must mirror their manifests.
const WORKFLOWS_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "core", "workflows")

test("kindBoards derives the engineering board from its manifest", () => {
  const boards = kindBoards(WORKFLOWS_DIR, parseConfig({}))
  // The three stable kinds are on with no config; only engineering is a board.
  assert.deepEqual(
    boards.map((b) => b.kind),
    ["engineering", "pr-sitter", "review-sitter"],
  )
  const eng = boards[0]!
  assert.equal(eng.kind, "engineering")
  assert.equal(eng.sourceType, "backlog")
  assert.deepEqual(eng.statuses, ["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"])
  // draft is a gate column too — declared via the manifest's humanGates, since
  // nothing transitions into it.
  assert.deepEqual([...eng.gateStatuses].sort(), ["draft", "in-review", "plan-review"])
  assert.deepEqual(eng.pools, ["in-progress", "queued"])
})

test("kindBoards includes opted-in kinds and excludes disabled ones", () => {
  const withDep = kindBoards(WORKFLOWS_DIR, parseConfig({ workflows: { "dep-sitter": { enabled: true } } }))
  assert.deepEqual(
    withDep.map((b) => [b.kind, b.sourceType]),
    [
      ["engineering", "backlog"],
      ["pr-sitter", "pull-request"],
      ["review-sitter", "pull-request"],
      ["dep-sitter", "dependency-scan"],
    ],
  )
  const sitter = withDep[1]!
  assert.deepEqual(sitter.statuses, [])
  assert.deepEqual(sitter.pools, [])
  // engineering is the only one of the three with an off switch; the released
  // sitters cannot be disabled, so they always have a board.
  const sitterOnly = kindBoards(WORKFLOWS_DIR, parseConfig({ workflows: { engineering: { enabled: false } } }))
  assert.deepEqual(
    sitterOnly.map((b) => b.kind),
    ["pr-sitter", "review-sitter"],
  )
})

test("kindBoards skips (with a warning) an enabled kind whose manifest doesn't load", () => {
  const warnings: string[] = []
  const boards = kindBoards(WORKFLOWS_DIR, parseConfig({ workflows: { ghost: { enabled: true } } }), (level, msg) => {
    if (level === "warn") warnings.push(msg)
  })
  assert.deepEqual(
    boards.map((b) => b.kind),
    ["engineering", "pr-sitter", "review-sitter"],
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /ghost/)
})

test("unionStatuses and unionGates dedupe across kinds", () => {
  const boards = [
    { kind: "a", description: "", sourceType: "backlog" as const, statuses: ["x", "y"], gateStatuses: ["y"], pools: ["x"] },
    { kind: "b", description: "", sourceType: "backlog" as const, statuses: ["y", "z"], gateStatuses: ["z", "y"], pools: [] },
  ]
  assert.deepEqual(unionStatuses(boards), ["x", "y", "z"])
  assert.deepEqual(unionGates(boards), ["y", "z"])
})
