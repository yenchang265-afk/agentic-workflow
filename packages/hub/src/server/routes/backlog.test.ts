import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { BacklogResponse, TaskDetailResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getBacklog, getTaskDetail } from "./backlog.js"

/** Build a real on-disk fixture backlog — the routes run against the same substrate production uses. */
const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-backlog-"))
  const tasks = path.join(dir, "docs", "tasks")
  for (const status of ["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"]) {
    fs.mkdirSync(path.join(tasks, status), { recursive: true })
  }
  fs.writeFileSync(
    path.join(tasks, "queued", "add-foo.md"),
    [
      "---",
      "title: Add foo support",
      "type: feature",
      "priority: 1",
      "labels: [backend]",
      "acceptance:",
      '  - "foo works"',
      "---",
      "",
      "Do the foo.",
      "> Task approved — queued [2026-07-01T10:00:00.000Z by alice]",
    ].join("\n"),
  )
  fs.writeFileSync(
    path.join(tasks, "plan-review", "fix-bar.md"),
    [
      "---",
      "title: Fix bar",
      "---",
      "",
      "Bar is broken.",
      "",
      "## Implementation Plan",
      "- change baz",
    ].join("\n"),
  )
  return dir
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("getBacklog rolls up tasks per status with cards and summary", async () => {
  const dir = makeFixture()
  const res = await getBacklog(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as BacklogResponse
  assert.equal(body.tasks["queued"]?.length, 1)
  const card = body.tasks["queued"]?.[0]
  assert.equal(card?.id, "add-foo")
  assert.equal(card?.title, "Add foo support")
  assert.equal(card?.priority, 1)
  assert.deepEqual(card?.labels, ["backend"])
  assert.equal(card?.hasPlan, false)
  assert.equal(body.tasks["plan-review"]?.[0]?.hasPlan, true)
  assert.deepEqual(body.summary.awaitingPlan, ["add-foo"])
  assert.deepEqual(body.summary.gated, ["fix-bar"])
  assert.equal(body.summary.counts["completed"], 0)
  assert.equal(body.anomalies, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getBacklog surfaces backlog anomalies", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(dir, "docs", "tasks", "stray.md"), "---\ntitle: stray\n---\n")
  const res = await getBacklog(depsFor(dir))
  const body = res.body as BacklogResponse
  assert.notEqual(body.anomalies, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getTaskDetail returns body, plan and audit notes", async () => {
  const dir = makeFixture()
  const res = await getTaskDetail(depsFor(dir), {
    params: { status: "plan-review", id: "fix-bar" },
    query: new URLSearchParams(),
  })
  assert.equal(res.status, 200)
  const body = res.body as TaskDetailResponse
  assert.equal(body.card.id, "fix-bar")
  assert.match(body.plan ?? "", /change baz/)
  const queued = await getTaskDetail(depsFor(dir), {
    params: { status: "queued", id: "add-foo" },
    query: new URLSearchParams(),
  })
  assert.deepEqual((queued.body as TaskDetailResponse).notes, [
    { event: "Task approved — queued", at: "2026-07-01T10:00:00.000Z", by: "alice" },
  ])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getTaskDetail 404s on a missing task and 400s on a bogus status", async () => {
  const dir = makeFixture()
  const missing = await getTaskDetail(depsFor(dir), {
    params: { status: "queued", id: "nope" },
    query: new URLSearchParams(),
  })
  assert.equal(missing.status, 404)
  const bogus = await getTaskDetail(depsFor(dir), {
    params: { status: "../../etc", id: "passwd" },
    query: new URLSearchParams(),
  })
  assert.equal(bogus.status, 400)
  fs.rmSync(dir, { recursive: true, force: true })
})
