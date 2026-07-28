import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { STAGE_MARKER_HOSTS, stageMarkerFile } from "@agentic-workflow/core/workflow/stage-marker"
import { diffSnapshots, scanSnapshot, type WatchSnapshot } from "./watch.js"

const GATES = ["plan-review", "in-review"] as const

const noMarkers = Object.fromEntries(STAGE_MARKER_HOSTS.map((h) => [h, null]))
const empty: WatchSnapshot = { tasks: {}, runs: {}, stageMarkers: noMarkers, lease: null, config: null }
/** One host's marker key, with every other host absent. */
const markers = (host: string, key: string | null): Partial<WatchSnapshot> => ({
  stageMarkers: { ...noMarkers, [host]: key },
})
const snap = (partial: Partial<WatchSnapshot>): WatchSnapshot => ({ ...empty, ...partial })

test("diffSnapshots on identical snapshots yields nothing", () => {
  const s = snap({ tasks: { queued: { "a.md": 1 } }, runs: { "a.md": "10:1" }, ...markers("claude", "5:2") })
  assert.deepEqual(diffSnapshots(s, s, GATES), [])
})

test("diffSnapshots emits backlog on any task change and gate on gate-folder arrivals", () => {
  const prev = snap({ tasks: { queued: { "a.md": 1 }, "plan-review": {} } })
  const moved = snap({ tasks: { queued: {}, "plan-review": { "a.md": 2 } } })
  const events = diffSnapshots(prev, moved, GATES)
  assert.deepEqual(events, [{ type: "gate", taskId: "a", toStatus: "plan-review" }, { type: "backlog" }])
})

test("diffSnapshots emits gate for a draft arriving — draft is a gate folder too", () => {
  const gates = [...GATES, "draft"] as const
  const prev = snap({ tasks: { draft: {} } })
  const authored = snap({ tasks: { draft: { "a.md": 1 } } })
  assert.deepEqual(diffSnapshots(prev, authored, gates), [{ type: "gate", taskId: "a", toStatus: "draft" }, { type: "backlog" }])
})

test("diffSnapshots does not emit gate for tasks merely edited in a gate folder", () => {
  const prev = snap({ tasks: { "in-review": { "a.md": 1 } } })
  const touched = snap({ tasks: { "in-review": { "a.md": 2 } } })
  assert.deepEqual(diffSnapshots(prev, touched, GATES), [{ type: "backlog" }])
})

test("diffSnapshots emits backlog (never gate) when a claim marker appears or vanishes", () => {
  // Claims come and go without touching any task .md — the board's claimed
  // badges hang off this. Even in a gate folder a `.claims/` key is not a task,
  // so it must never mint a gate notification.
  const prev = snap({ tasks: { queued: { "a.md": 1 }, "plan-review": {} } })
  const claimedInGate = snap({ tasks: { queued: { "a.md": 1 }, "plan-review": { ".claims/a": 1 } } })
  assert.deepEqual(diffSnapshots(prev, claimedInGate, GATES), [{ type: "backlog" }])
  assert.deepEqual(diffSnapshots(claimedInGate, prev, GATES), [{ type: "backlog" }])
})

test("scanSnapshot lists claim markers under a status's .claims dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-watch-claims-"))
  try {
    fs.mkdirSync(path.join(dir, "docs/tasks/queued/.claims/T-1"), { recursive: true })
    fs.writeFileSync(path.join(dir, "docs/tasks/queued/task.md"), "x")
    const s = scanSnapshot(dir, "docs/tasks", ["queued"])
    assert.deepEqual(Object.keys(s.tasks["queued"] ?? {}).sort(), [".claims/T-1", "task.md"])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("diffSnapshots emits sched (never run) for the event log — a run event would collapse the open panel", () => {
  const prev = snap({ runs: {} })
  const grown = snap({ runs: { "events.jsonl": "100:1" } })
  assert.deepEqual(diffSnapshots(prev, grown, GATES), [{ type: "sched" }])
  const rotated = snap({ runs: { "events.jsonl": "10:2", "events.1.jsonl": "100:1" } })
  assert.deepEqual(diffSnapshots(grown, rotated, GATES), [{ type: "sched" }])
})

test("diffSnapshots emits run for changed run logs and active for marker/lease/state changes", () => {
  const prev = snap({ runs: { "fix.md": "10:1", "fix.state.json": "5:1" }, lease: null })
  const next = snap({ runs: { "fix.md": "20:2", "fix.state.json": "6:2" }, ...markers("claude", "9:9"), lease: "3:3" })
  const events = diffSnapshots(prev, next, GATES)
  assert.deepEqual(events, [{ type: "run", id: "fix" }, { type: "active" }])
})

test("diffSnapshots emits active when the OpenCode sibling marker appears or vanishes", () => {
  const prev = snap({})
  const started = snap(markers("opencode", "7:1"))
  assert.deepEqual(diffSnapshots(prev, started, GATES), [{ type: "active" }])
  assert.deepEqual(diffSnapshots(started, prev, GATES), [{ type: "active" }])
})

test("diffSnapshots emits exactly one tokens event (not run) for a changed metrics sidecar", () => {
  const prev = snap({ runs: { "fix.metrics.json": "10:1" } })
  const next = snap({ runs: { "fix.metrics.json": "22:2" } })
  assert.deepEqual(diffSnapshots(prev, next, GATES), [{ type: "tokens", id: "fix" }])
})

test("scanSnapshot picks up .metrics.json sidecars under runs/", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-watch-metrics-"))
  const runs = path.join(dir, "docs", "tasks", "runs")
  fs.mkdirSync(runs, { recursive: true })
  fs.writeFileSync(path.join(runs, "fix.metrics.json"), '{"version":1,"runs":[]}')
  const s = scanSnapshot(dir, "docs/tasks", ["queued"])
  assert.ok(s.runs["fix.metrics.json"])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("scanSnapshot reads folders, runs and markers from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-watch-"))
  const tasks = path.join(dir, "docs", "tasks")
  fs.mkdirSync(path.join(tasks, "queued"), { recursive: true })
  fs.mkdirSync(path.join(tasks, "runs", ".watch-lease"), { recursive: true })
  fs.writeFileSync(path.join(tasks, "queued", "a.md"), "---\ntitle: a\n---\n")
  fs.writeFileSync(path.join(tasks, "runs", "a.md"), "log")
  for (const host of STAGE_MARKER_HOSTS) fs.writeFileSync(path.join(tasks, "runs", stageMarkerFile(host)), "{}")
  fs.writeFileSync(path.join(tasks, "runs", ".watch-lease", "owner.json"), "{}")
  const s = scanSnapshot(dir, "docs/tasks", ["queued", "plan-review"])
  assert.ok(s.tasks["queued"]?.["a.md"])
  assert.deepEqual(s.tasks["plan-review"], {})
  assert.ok(s.runs["a.md"])
  for (const host of STAGE_MARKER_HOSTS) assert.notEqual(s.stageMarkers[host], null, `${host} marker not scanned`)
  assert.notEqual(s.lease, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("diffSnapshots emits gate for arrivals in a custom (manifest-declared) gate folder", () => {
  const prev = snap({ tasks: { "waiting-human": {} } })
  const next = snap({ tasks: { "waiting-human": { "t.md": 1 } } })
  const events = diffSnapshots(prev, next, ["waiting-human"])
  assert.deepEqual(events, [{ type: "gate", taskId: "t", toStatus: "waiting-human" }, { type: "backlog" }])
})

test("diffSnapshots emits config when .agentic-workflow.json changes", () => {
  const prev = snap({ config: "100:1" })
  const next = snap({ config: "120:2" })
  assert.deepEqual(diffSnapshots(prev, next, GATES), [{ type: "config" }])
  // Appearing and disappearing both count — a deleted config falls back to defaults.
  assert.deepEqual(diffSnapshots(snap({ config: null }), prev, GATES), [{ type: "config" }])
  assert.deepEqual(diffSnapshots(prev, snap({ config: null }), GATES), [{ type: "config" }])
})

test("scanSnapshot picks up the config file, which lives outside tasksDir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-watch-cfg-"))
  fs.mkdirSync(path.join(dir, "docs", "tasks", "queued"), { recursive: true })
  assert.equal(scanSnapshot(dir, "docs/tasks", ["queued"]).config, null, "absent config reads as null")

  fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), JSON.stringify({ maxIterations: 3 }))
  const withCfg = scanSnapshot(dir, "docs/tasks", ["queued"])
  assert.notEqual(withCfg.config, null, "the poll is what delivers this — fs.watch never sees it")
  fs.rmSync(dir, { recursive: true, force: true })
})
