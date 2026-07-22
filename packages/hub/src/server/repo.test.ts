import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Log } from "@agentic-workflow/core/host"
import { makeRepo } from "./repo.js"

/**
 * Reload is the primitive every hub write builds on: config is read once at
 * startup, so without it a saved config edit needs a server restart. Its rails
 * are what these tests pin — above all that a broken config keeps the last good
 * one rather than blanking the board.
 */

const makeFixture = (config?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-repo-"))
  if (config !== undefined) fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), config)
  return dir
}

const silent: Log = () => {}

const warnings = (): { log: Log; seen: string[] } => {
  const seen: string[] = []
  return { log: (level, message) => void (level === "warn" && seen.push(message)), seen }
}

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

test("a repo with no config file builds on the defaults", async () => {
  const dir = makeFixture()
  const repo = await makeRepo("r1", dir, silent)
  assert.equal(repo.id, "r1")
  assert.equal(repo.deps.tasksDir, "docs/tasks")
  assert.equal(repo.deps.config.maxIterations, 3)
  cleanup(dir)
})

test("reload picks up an edited config and swaps deps wholesale", async () => {
  const dir = makeFixture(JSON.stringify({ maxIterations: 3 }))
  const repo = await makeRepo("r1", dir, silent)
  const before = repo.deps
  assert.equal(repo.deps.config.maxIterations, 3)

  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), JSON.stringify({ maxIterations: 9 }))
  assert.equal(await repo.reload(), true)

  assert.equal(repo.deps.config.maxIterations, 9)
  // Swapped, not mutated: the old deps object is untouched, so any handler
  // mid-request keeps reading a coherent config.
  assert.notEqual(repo.deps, before)
  assert.equal(before.config.maxIterations, 3)
  cleanup(dir)
})

test("reload of malformed JSON keeps the last good config and warns", async () => {
  const dir = makeFixture(JSON.stringify({ maxIterations: 3 }))
  const { log, seen } = warnings()
  const repo = await makeRepo("r1", dir, log)
  const good = repo.deps

  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), "{ not json")
  assert.equal(await repo.reload(), false)

  assert.equal(repo.deps, good, "a broken hand-edit must never blank the board")
  assert.equal(repo.deps.config.maxIterations, 3)
  assert.equal(seen.length, 1)
  assert.match(seen[0] ?? "", /keeping the last good config/)
  cleanup(dir)
})

test("reload of a schema-invalid config keeps the last good config", async () => {
  const dir = makeFixture(JSON.stringify({ maxIterations: 3 }))
  const repo = await makeRepo("r1", dir, silent)
  const good = repo.deps

  // codePlatform "ado" without an ado section trips the schema's cross-field
  // refinement — invalid, not merely unparseable.
  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), JSON.stringify({ codePlatform: "ado" }))
  assert.equal(await repo.reload(), false)

  assert.equal(repo.deps, good)
  cleanup(dir)
})

test("a reload that moves tasksDir signals the watcher, which is built from it", async () => {
  const dir = makeFixture(JSON.stringify({ tasksDir: "docs/tasks" }))
  const fired: string[] = []
  const repo = await makeRepo("r1", dir, silent, (r) => fired.push(r.deps.tasksDir))

  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), JSON.stringify({ tasksDir: "work/items" }))
  assert.equal(await repo.reload(), true)

  assert.deepEqual(fired, ["work/items"], "otherwise the watcher scans the old folder forever")
  cleanup(dir)
})

test("a reload that leaves the watch shape alone does not churn the watcher", async () => {
  const dir = makeFixture(JSON.stringify({ tasksDir: "docs/tasks", maxIterations: 3 }))
  let fired = 0
  const repo = await makeRepo("r1", dir, silent, () => void fired++)

  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), JSON.stringify({ tasksDir: "docs/tasks", maxIterations: 9 }))
  assert.equal(await repo.reload(), true)

  assert.equal(repo.deps.config.maxIterations, 9)
  assert.equal(fired, 0)
  cleanup(dir)
})
