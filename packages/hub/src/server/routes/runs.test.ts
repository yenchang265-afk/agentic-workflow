import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { ActiveResponse, RunDetailResponse, RunsResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getActive } from "./active.js"
import { getRunDetail, getRuns } from "./runs.js"

const SUMMARY = [
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
].join("\n")

const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-runs-"))
  const runs = path.join(dir, "docs", "tasks", "runs")
  fs.mkdirSync(runs, { recursive: true })
  fs.writeFileSync(path.join(runs, "fix-bar.md"), SUMMARY)
  fs.writeFileSync(path.join(runs, "no-summary.md"), "\n## build · iteration 1 · 2026-07-06T10:00:00.000Z\n\nbuilt it\n")
  fs.writeFileSync(
    path.join(runs, "fix-bar.state.json"),
    JSON.stringify({
      kind: "engineering",
      goal: "fix bar",
      stage: "verify",
      iteration: 1,
      artifacts: {},
      task: { id: "fix-bar", path: "x", title: "Fix bar" },
      git: { base: "main", branch: "feature/fix-bar" },
    }),
  )
  return dir
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  // A github-pr kind so getActive scans its runs/<kind>/ ledger dir.
  boards: [{ kind: "pr-sitter", description: "pr sitter", sourceType: "github-pr", statuses: [], gateStatuses: [], pools: [] }],
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("getRuns lists run logs, latest summary first", async () => {
  const dir = makeFixture()
  const res = await getRuns(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as RunsResponse
  assert.equal(body.runs.length, 2)
  assert.equal(body.runs[0]?.id, "fix-bar")
  assert.equal(body.runs[0]?.outcome, "done")
  assert.equal(body.runs[0]?.detail, "review passed")
  assert.equal(body.runs[0]?.runs, 1)
  assert.equal(body.runs[1]?.id, "no-summary")
  assert.equal(body.runs[1]?.outcome, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getRunDetail returns parsed log + display snapshot", async () => {
  const dir = makeFixture()
  const res = await getRunDetail(depsFor(dir), { params: { id: "fix-bar" }, query: new URLSearchParams() })
  assert.equal(res.status, 200)
  const body = res.body as RunDetailResponse
  assert.equal(body.log.summaries.length, 1)
  assert.equal(body.snapshot?.stage, "verify")
  assert.equal(body.snapshot?.taskId, "fix-bar")
  assert.equal(body.snapshot?.branch, "feature/fix-bar")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getRunDetail 404s on missing or malformed ids", async () => {
  const dir = makeFixture()
  const missing = await getRunDetail(depsFor(dir), { params: { id: "nope" }, query: new URLSearchParams() })
  assert.equal(missing.status, 404)
  const traversal = await getRunDetail(depsFor(dir), {
    params: { id: "../../.agentic-loop" },
    query: new URLSearchParams(),
  })
  assert.equal(traversal.status, 404)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getActive reports stage marker, snapshots and ledgers when present, nulls when absent", async () => {
  const dir = makeFixture()
  const deps = depsFor(dir)
  const empty = (await getActive(deps)).body as ActiveResponse
  assert.equal(empty.stage, null)
  assert.equal(empty.lease, null)
  assert.deepEqual(empty.snapshotIds, ["fix-bar"])
  assert.deepEqual(empty.prLedgers, [])

  const runs = path.join(dir, "docs", "tasks", "runs")
  fs.writeFileSync(
    path.join(runs, ".stage.json"),
    JSON.stringify({ kind: "engineering", stage: "build", taskId: "fix-bar", worktree: null, deadline: 123 }),
  )
  fs.mkdirSync(path.join(runs, "pr-sitter"))
  fs.writeFileSync(
    path.join(runs, "pr-sitter", "pr-7.json"),
    JSON.stringify({ pr: 7, updatedAt: "2026-07-06T00:00:00.000Z", failedAttempts: [{}, {}] }),
  )
  const full = (await getActive(deps)).body as ActiveResponse
  assert.equal(full.stage?.stage, "build")
  assert.equal(full.stage?.taskId, "fix-bar")
  assert.deepEqual(full.prLedgers, [{ pr: 7, updatedAt: "2026-07-06T00:00:00.000Z", failedAttempts: 2 }])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getActive reads the watch lease and judges staleness", async () => {
  const dir = makeFixture()
  const leaseDir = path.join(dir, "docs", "tasks", "runs", ".watch-lease")
  fs.mkdirSync(leaseDir, { recursive: true })
  const fresh = new Date().toISOString()
  fs.writeFileSync(
    path.join(leaseDir, "owner.json"),
    JSON.stringify({ pid: 4242, host: "opencode", startedAt: fresh, heartbeatAt: fresh, intervalMs: 60000 }),
  )
  const body = (await getActive(depsFor(dir))).body as ActiveResponse
  assert.equal(body.lease?.pid, 4242)
  assert.equal(body.lease?.stale, false)

  const old = "2026-01-01T00:00:00.000Z"
  fs.writeFileSync(
    path.join(leaseDir, "owner.json"),
    JSON.stringify({ pid: 4242, host: "opencode", startedAt: old, heartbeatAt: old, intervalMs: 60000 }),
  )
  const staleBody = (await getActive(depsFor(dir))).body as ActiveResponse
  assert.equal(staleBody.lease?.stale, true)
  fs.rmSync(dir, { recursive: true, force: true })
})
