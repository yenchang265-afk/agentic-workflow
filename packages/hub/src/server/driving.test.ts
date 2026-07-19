import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-loop/core/config"
import type { KindBoardInfo } from "../shared/api.js"
import type { HubDeps } from "./deps.js"
import { makeDrivingOracle, readStageMarker } from "./driving.js"
import { fsClient, sh } from "./fsclient.js"

/**
 * The `isDriving` oracle. Every case here answers one question: may a gate move
 * touch this task, or is something already driving it? A false "not driving"
 * re-queues a task mid-BUILD and destroys work, so the bias is deliberate and
 * the matrix below pins it.
 */

const BOARDS: readonly KindBoardInfo[] = [
  {
    kind: "engineering",
    description: "",
    sourceType: "backlog",
    statuses: ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"],
    gateStatuses: ["plan-review", "in-review"],
    pools: ["queued", "in-progress"],
  },
]

const TASKS_DIR = "docs/tasks"

const makeFixture = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-driving-"))

const writeMarker = (dir: string, marker: unknown): void => {
  const p = path.join(dir, TASKS_DIR, "runs", ".stage.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof marker === "string" ? marker : JSON.stringify(marker))
}

/** A claim is an atomically-created directory (see claimTask's mkdir). */
const writeClaim = (dir: string, status: string, id: string): void => {
  fs.mkdirSync(path.join(dir, TASKS_DIR, status, ".claims", id), { recursive: true })
}

const writeLease = (dir: string, heartbeatAt: string, intervalMs = 60_000): void => {
  const p = path.join(dir, TASKS_DIR, "runs", ".watch-lease", "owner.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ pid: 4242, host: "testhost", startedAt: heartbeatAt, heartbeatAt, intervalMs }))
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: TASKS_DIR,
  boards: BOARDS,
  config: DEFAULT_CONFIG,
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

test("a bare backlog drives nothing", async () => {
  const dir = makeFixture()
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.isDriving("f7k3-add-rate-limit"), false)
  assert.equal(o.markerTaskId, null)
  assert.equal(o.watcherLive, false)
  assert.equal(o.leasePid, null)
  assert.deepEqual(o.claimedIds, [])
  cleanup(dir)
})

test("a stage marker naming a task drives it, and only it", async () => {
  const dir = makeFixture()
  writeMarker(dir, { kind: "engineering", stage: "build", taskId: "f7k3-add-rate-limit" })
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.isDriving("f7k3-add-rate-limit"), true)
  assert.equal(o.isDriving("other-task"), false)
  assert.equal(o.markerTaskId, "f7k3-add-rate-limit")
  cleanup(dir)
})

test("a claim marker drives its task even with no stage marker (the opencode host writes none)", async () => {
  const dir = makeFixture()
  writeClaim(dir, "in-progress", "f7k3-add-rate-limit")
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.isDriving("f7k3-add-rate-limit"), true)
  assert.equal(o.markerTaskId, null)
  assert.deepEqual(o.claimedIds, ["f7k3-add-rate-limit"])
  cleanup(dir)
})

test("a PLAN claim in the queued pool counts — claims are scanned across every pool", async () => {
  const dir = makeFixture()
  writeClaim(dir, "queued", "b2m9-cache-warmup")
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.isDriving("b2m9-cache-warmup"), true)
  cleanup(dir)
})

test("a stage marker with no taskId drives no task (a sitter stage runs on a PR, not a task)", async () => {
  const dir = makeFixture()
  writeMarker(dir, { kind: "pr-sitter", stage: "pr-fix", taskId: null })
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.markerTaskId, null)
  assert.equal(o.isDriving("f7k3-add-rate-limit"), false)
  cleanup(dir)
})

test("a stage marker's iteration passes through — the board badge needs it to show retry count", async () => {
  const dir = makeFixture()
  writeMarker(dir, { kind: "engineering", stage: "build", taskId: "f7k3-add-rate-limit", iteration: 2 })
  const marker = await readStageMarker(depsFor(dir))
  assert.equal(marker?.iteration, 2)
  cleanup(dir)
})

test("a garbled stage marker reads as absent rather than throwing", async () => {
  const dir = makeFixture()
  writeMarker(dir, "{ not json")
  const deps = depsFor(dir)
  assert.equal(await readStageMarker(deps), null)
  const o = await makeDrivingOracle(deps)
  assert.equal(o.isDriving("f7k3-add-rate-limit"), false)
  cleanup(dir)
})

test("a fresh lease reads as a live watcher, with its pid for the refusal message", async () => {
  const dir = makeFixture()
  const now = new Date("2026-07-15T12:00:00Z")
  writeLease(dir, "2026-07-15T11:59:30Z")
  const o = await makeDrivingOracle(depsFor(dir), now)
  assert.equal(o.watcherLive, true)
  assert.equal(o.leasePid, 4242)
  cleanup(dir)
})

test("a lease past the stale threshold is not a live watcher", async () => {
  const dir = makeFixture()
  const now = new Date("2026-07-15T12:00:00Z")
  writeLease(dir, "2026-07-15T11:00:00Z") // an hour of missed heartbeats
  const o = await makeDrivingOracle(depsFor(dir), now)
  assert.equal(o.watcherLive, false)
  assert.equal(o.leasePid, null)
  cleanup(dir)
})

test("a live watcher alone drives nothing — it claims before it drives, so claims are the signal", async () => {
  const dir = makeFixture()
  const now = new Date("2026-07-15T12:00:00Z")
  writeLease(dir, "2026-07-15T11:59:30Z")
  const o = await makeDrivingOracle(depsFor(dir), now)
  assert.equal(o.watcherLive, true)
  assert.equal(o.isDriving("f7k3-add-rate-limit"), false)
  cleanup(dir)
})

test("a stranded claim still reads as driving — when unsure, say driving (doctor releases it)", async () => {
  const dir = makeFixture()
  writeClaim(dir, "in-progress", "f7k3-add-rate-limit")
  // No marker, no lease: the loop that held this claim is long gone. Refusing a
  // replan here is a recoverable annoyance; allowing one mid-BUILD is not.
  const o = await makeDrivingOracle(depsFor(dir))
  assert.equal(o.watcherLive, false)
  assert.equal(o.isDriving("f7k3-add-rate-limit"), true)
  cleanup(dir)
})
