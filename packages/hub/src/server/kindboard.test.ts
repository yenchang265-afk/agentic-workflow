import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { parseConfig } from "@agentic-workflow/core/config"
import { kindBoards, unionGates, unionStatuses } from "./kindboard.js"

// The shipped workflow kinds are the fixture — boards must mirror their manifests.
const WORKFLOWS_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "core", "workflows")

test("kindBoards derives the engineering board from its manifest", () => {
  const boards = kindBoards(WORKFLOWS_DIR, parseConfig({}))
  assert.equal(boards.length, 1)
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
  const both = kindBoards(WORKFLOWS_DIR, parseConfig({ workflows: { "pr-sitter": { enabled: true } } }))
  assert.deepEqual(
    both.map((b) => [b.kind, b.sourceType]),
    [
      ["engineering", "backlog"],
      ["pr-sitter", "pull-request"],
    ],
  )
  const sitter = both[1]!
  assert.deepEqual(sitter.statuses, [])
  assert.deepEqual(sitter.pools, [])
  const sitterOnly = kindBoards(
    WORKFLOWS_DIR,
    parseConfig({ workflows: { engineering: { enabled: false }, "pr-sitter": { enabled: true } } }),
  )
  assert.deepEqual(
    sitterOnly.map((b) => b.kind),
    ["pr-sitter"],
  )
})

test("kindBoards skips (with a warning) an enabled kind whose manifest doesn't load", () => {
  const warnings: string[] = []
  const boards = kindBoards(WORKFLOWS_DIR, parseConfig({ workflows: { ghost: { enabled: true } } }), (level, msg) => {
    if (level === "warn") warnings.push(msg)
  })
  assert.deepEqual(
    boards.map((b) => b.kind),
    ["engineering"],
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
