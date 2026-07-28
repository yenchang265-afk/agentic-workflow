import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { SchedulerEventsResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getSchedulerEvents } from "./scheduler.js"

/** The scheduler-events route over a real runs/ directory: generation order, tail cap, fail-open lines. */

const TASKS_DIR = "docs/tasks"

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: TASKS_DIR,
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sched-"))
  fs.mkdirSync(path.join(dir, TASKS_DIR, "runs"), { recursive: true })
  return dir
}

const line = (type: string, at: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, at, host: "opencode", pid: 1, ...extra })

const body = async (dir: string): Promise<SchedulerEventsResponse> => {
  const res = await getSchedulerEvents(depsFor(dir))
  return res.body as SchedulerEventsResponse
}

test("returns [] when no event log exists", async () => {
  const dir = makeFixture()
  try {
    assert.deepEqual((await body(dir)).events, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("concatenates the rotated generation first and returns newest-first", async () => {
  const dir = makeFixture()
  try {
    fs.writeFileSync(
      path.join(dir, TASKS_DIR, "runs", "events.1.jsonl"),
      `${line("claim", "2026-07-28T00:00:00.000Z", { kind: "engineering", id: "T-old" })}\n`,
    )
    fs.writeFileSync(
      path.join(dir, TASKS_DIR, "runs", "events.jsonl"),
      [
        line("claim", "2026-07-28T01:00:00.000Z", { kind: "engineering", id: "T-new" }),
        "not json — a torn line must not take the feed down",
        line("terminal", "2026-07-28T02:00:00.000Z", { kind: "engineering", id: "T-new", outcome: "done" }),
      ].join("\n"),
    )
    const { events } = await body(dir)
    assert.deepEqual(
      events.map((e) => [e.type, e.id ?? e.at]),
      [
        ["terminal", "T-new"],
        ["claim", "T-new"],
        ["claim", "T-old"],
      ],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("caps the tail at 200 newest events", async () => {
  const dir = makeFixture()
  try {
    const lines = Array.from({ length: 250 }, (_, i) =>
      line("claim", `2026-07-28T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, {
        kind: "engineering",
        id: `T-${i}`,
      }),
    )
    fs.writeFileSync(path.join(dir, TASKS_DIR, "runs", "events.jsonl"), lines.join("\n"))
    const { events } = await body(dir)
    assert.equal(events.length, 200)
    assert.equal(events[0]?.id, "T-249") // newest first
    assert.equal(events[199]?.id, "T-50") // the 50 oldest dropped
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
