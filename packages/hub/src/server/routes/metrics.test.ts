import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { MetricsResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getMetrics } from "./metrics.js"

const LOG = [
  "",
  "## run · done",
  "",
  "## Run summary · done: review passed · 2026-07-05T13:16:25.138Z",
  "",
  "| # | stage | iter | verdict | wall-clock |",
  "|---|-------|------|---------|------------|",
  "| 1 | build | 1 | — | 20s |",
  "| 2 | verify | 1 | PASS | 16s |",
  "",
  "iterations used: 1/3 · total: 36s · outcome: done",
  "",
].join("\n")

const SIDECAR = JSON.stringify({
  version: 1,
  runs: [
    {
      endedAt: "2026-07-05T13:16:25.138Z",
      outcome: "done",
      detail: "",
      host: "opencode",
      samples: [
        {
          stage: "build",
          iteration: 0,
          ms: 20000,
          tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 900, cacheWrite: 0 },
        },
      ],
    },
  ],
})

const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-metrics-"))
  fs.mkdirSync(path.join(dir, "docs", "tasks", "runs"), { recursive: true })
  return dir
}

const runsDir = (dir: string): string => path.join(dir, "docs", "tasks", "runs")

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: "/workflows-unused",
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("getMetrics joins run logs with their token sidecars", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(runsDir(dir), "fix-bar.md"), LOG)
  fs.writeFileSync(path.join(runsDir(dir), "fix-bar.metrics.json"), SIDECAR)

  const res = await getMetrics(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as MetricsResponse

  assert.equal(body.runsTotal, 1)
  assert.equal(body.passesTotal, 1)
  assert.deepEqual(body.outcomes, { done: 1 })
  assert.equal(body.burn.capTripRate, 0)
  assert.equal(body.firstPass.rate, 1)
  assert.equal(body.cache.ratio, 0.9)
  assert.equal(body.cache.runsCovered, 1)
  assert.deepEqual(body.skippedRuns, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getMetrics survives a corrupt sidecar without losing the run", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(runsDir(dir), "fix-bar.md"), LOG)
  // A torn write mid-flush, or hand-editing. `parseRunMetrics` fails closed.
  fs.writeFileSync(path.join(runsDir(dir), "fix-bar.metrics.json"), "{ not json")

  const body = (await getMetrics(depsFor(dir))).body as MetricsResponse
  assert.equal(body.runsTotal, 1)
  assert.equal(body.passesTotal, 1) // the log still counts
  assert.equal(body.cache.ratio, null) // but tokens are unmeasurable, not 0
  assert.equal(body.cache.runsCovered, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getMetrics reports a listed-but-unreadable log instead of dropping it", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(runsDir(dir), "fix-bar.md"), LOG)
  // A dangling symlink lists as a file and reads as null — the shape a
  // permission problem or a half-cleaned worktree also produces.
  fs.symlinkSync(path.join(runsDir(dir), "gone.md"), path.join(runsDir(dir), "broken.md"))

  const body = (await getMetrics(depsFor(dir))).body as MetricsResponse
  assert.deepEqual(body.skippedRuns, ["broken"])
  assert.equal(body.runsTotal, 1) // the unreadable one is NOT in the denominator
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getMetrics returns an empty roll-up, not a 404, when no runs exist", async () => {
  const dir = makeFixture()
  const res = await getMetrics(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as MetricsResponse

  assert.equal(body.runsTotal, 0)
  assert.equal(body.passesTotal, 0)
  // Nothing measured — every rate must be null rather than a confident zero.
  assert.equal(body.burn.capTripRate, null)
  assert.equal(body.burn.meanRatio, null)
  assert.equal(body.firstPass.rate, null)
  assert.equal(body.cache.ratio, null)
  assert.deepEqual(body.verdicts, [])
  assert.deepEqual(body.durations, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getMetrics tolerates a missing runs/ directory entirely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-metrics-bare-"))
  const body = (await getMetrics(depsFor(dir))).body as MetricsResponse
  assert.equal(body.runsTotal, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})
