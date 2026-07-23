import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { HubDeps } from "./deps.js"
import { fsClient, sh } from "./fsclient.js"
import { mapBounded, readText } from "./io.js"

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("readText reads a repo-relative file and reports missing or escaping paths as null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-io-"))
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true })
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "hello")
  const deps = depsFor(dir)
  assert.equal(await readText(deps, "docs/a.md"), "hello")
  assert.equal(await readText(deps, "docs/missing.md"), null)
  // The fsClient containment rail: a path that resolves outside the repo reads as null.
  assert.equal(await readText(deps, "../outside.md"), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("mapBounded preserves item order regardless of completion order", async () => {
  const delays = [30, 1, 15, 5]
  const out = await mapBounded(delays, 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms))
    return `${i}:${ms}`
  })
  assert.deepEqual(out, ["0:30", "1:1", "2:15", "3:5"])
})

test("mapBounded never runs more than `limit` items at once", async () => {
  let inFlight = 0
  let peak = 0
  await mapBounded(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
  })
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`)
  assert.ok(peak > 1, "items did not actually overlap — the pool ran serially")
})

test("mapBounded handles an empty list", async () => {
  assert.deepEqual(await mapBounded([], 8, async () => 1), [])
})
