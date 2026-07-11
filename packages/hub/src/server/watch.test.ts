import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { diffSnapshots, scanSnapshot, type WatchSnapshot } from "./watch.js"

const GATES = ["plan-review", "in-review"] as const

const empty: WatchSnapshot = { tasks: {}, runs: {}, stageMarker: null, lease: null }
const snap = (partial: Partial<WatchSnapshot>): WatchSnapshot => ({ ...empty, ...partial })

test("diffSnapshots on identical snapshots yields nothing", () => {
  const s = snap({ tasks: { queued: { "a.md": 1 } }, runs: { "a.md": "10:1" }, stageMarker: "5:2" })
  assert.deepEqual(diffSnapshots(s, s, GATES), [])
})

test("diffSnapshots emits backlog on any task change and gate on gate-folder arrivals", () => {
  const prev = snap({ tasks: { queued: { "a.md": 1 }, "plan-review": {} } })
  const moved = snap({ tasks: { queued: {}, "plan-review": { "a.md": 2 } } })
  const events = diffSnapshots(prev, moved, GATES)
  assert.deepEqual(events, [{ type: "gate", taskId: "a", toStatus: "plan-review" }, { type: "backlog" }])
})

test("diffSnapshots does not emit gate for tasks merely edited in a gate folder", () => {
  const prev = snap({ tasks: { "in-review": { "a.md": 1 } } })
  const touched = snap({ tasks: { "in-review": { "a.md": 2 } } })
  assert.deepEqual(diffSnapshots(prev, touched, GATES), [{ type: "backlog" }])
})

test("diffSnapshots emits run for changed run logs and active for marker/lease/state changes", () => {
  const prev = snap({ runs: { "fix.md": "10:1", "fix.state.json": "5:1" }, stageMarker: null, lease: null })
  const next = snap({ runs: { "fix.md": "20:2", "fix.state.json": "6:2" }, stageMarker: "9:9", lease: "3:3" })
  const events = diffSnapshots(prev, next, GATES)
  assert.deepEqual(events, [{ type: "run", id: "fix" }, { type: "active" }])
})

test("scanSnapshot reads folders, runs and markers from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-watch-"))
  const tasks = path.join(dir, "docs", "tasks")
  fs.mkdirSync(path.join(tasks, "queued"), { recursive: true })
  fs.mkdirSync(path.join(tasks, "runs", ".watch-lease"), { recursive: true })
  fs.writeFileSync(path.join(tasks, "queued", "a.md"), "---\ntitle: a\n---\n")
  fs.writeFileSync(path.join(tasks, "runs", "a.md"), "log")
  fs.writeFileSync(path.join(tasks, "runs", ".stage.json"), "{}")
  fs.writeFileSync(path.join(tasks, "runs", ".watch-lease", "owner.json"), "{}")
  const s = scanSnapshot(dir, "docs/tasks", ["queued", "plan-review"])
  assert.ok(s.tasks["queued"]?.["a.md"])
  assert.deepEqual(s.tasks["plan-review"], {})
  assert.ok(s.runs["a.md"])
  assert.notEqual(s.stageMarker, null)
  assert.notEqual(s.lease, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("diffSnapshots emits gate for arrivals in a custom (manifest-declared) gate folder", () => {
  const prev = snap({ tasks: { "waiting-human": {} } })
  const next = snap({ tasks: { "waiting-human": { "t.md": 1 } } })
  const events = diffSnapshots(prev, next, ["waiting-human"])
  assert.deepEqual(events, [{ type: "gate", taskId: "t", toStatus: "waiting-human" }, { type: "backlog" }])
})
