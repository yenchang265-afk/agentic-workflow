import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-loop/core/config"
import type { BacklogResponse, KindBoardInfo, TaskDetailResponse } from "../../shared/api.js"
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

const ENGINEERING_BOARD: KindBoardInfo = {
  kind: "engineering",
  description: "engineering",
  sourceType: "backlog",
  statuses: ["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"],
  gateStatuses: ["draft", "plan-review", "in-review"],
  pools: ["in-progress", "queued"],
}

const depsFor = (directory: string, boards: readonly KindBoardInfo[] = [ENGINEERING_BOARD]): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards,
  config: DEFAULT_CONFIG,
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("getBacklog rolls up tasks per status with cards and summary", async () => {
  const dir = makeFixture()
  const res = await getBacklog(depsFor(dir), { params: {}, query: new URLSearchParams() })
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
  assert.deepEqual(body.summary?.awaitingPlan, ["add-foo"])
  assert.deepEqual(body.summary?.gated, ["fix-bar"])
  assert.equal(body.summary?.counts["completed"], 0)
  assert.equal(body.anomalies, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getBacklog surfaces backlog anomalies", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(dir, "docs", "tasks", "stray.md"), "---\ntitle: stray\n---\n")
  const res = await getBacklog(depsFor(dir), { params: {}, query: new URLSearchParams() })
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

test("getTaskDetail 400s on a traversal id and never reaches the filesystem", async () => {
  const dir = makeFixture()
  // A secret .md outside the backlog that a `..`-traversal id would resolve to.
  fs.writeFileSync(path.join(dir, "secret.md"), "---\ntitle: secret\n---\ntop secret")
  // `matchRoute` percent-decodes segments, so `..%2f..%2fsecret` arrives as this.
  const res = await getTaskDetail(depsFor(dir), {
    params: { status: "queued", id: "../../secret" },
    query: new URLSearchParams(),
  })
  assert.equal(res.status, 400)
  assert.match((res.body as { error: string }).error, /invalid task id/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getBacklog serves a non-engineering backlog kind from its manifest shape, without the lifecycle summary", async () => {
  const dir = makeFixture()
  const tasks = path.join(dir, "docs", "tasks")
  fs.mkdirSync(path.join(tasks, "inbox"), { recursive: true })
  fs.mkdirSync(path.join(tasks, "waiting-human"), { recursive: true })
  fs.writeFileSync(path.join(tasks, "inbox", "triage-me.md"), "---\ntitle: Triage me\n---\n")
  const board: KindBoardInfo = {
    kind: "triage",
    description: "triage kind",
    sourceType: "backlog",
    statuses: ["inbox", "waiting-human"],
    gateStatuses: ["waiting-human"],
    pools: ["inbox"],
  }
  const res = await getBacklog(depsFor(dir, [ENGINEERING_BOARD, board]), {
    params: {},
    query: new URLSearchParams("kind=triage"),
  })
  assert.equal(res.status, 200)
  const body = res.body as BacklogResponse
  assert.equal(body.kind, "triage")
  assert.deepEqual(body.statuses, ["inbox", "waiting-human"])
  assert.deepEqual(body.gateStatuses, ["waiting-human"])
  assert.equal(body.tasks["inbox"]?.[0]?.id, "triage-me")
  assert.equal(body.summary, null)
  assert.equal(body.anomalies, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getBacklog 404s on an unknown kind and 400s on a boardless (github-pr) kind", async () => {
  const dir = makeFixture()
  const pr: KindBoardInfo = {
    kind: "pr-sitter",
    description: "pr sitter",
    sourceType: "github-pr",
    statuses: [],
    gateStatuses: [],
    pools: [],
  }
  const unknown = await getBacklog(depsFor(dir), { params: {}, query: new URLSearchParams("kind=nope") })
  assert.equal(unknown.status, 404)
  const boardless = await getBacklog(depsFor(dir, [ENGINEERING_BOARD, pr]), {
    params: {},
    query: new URLSearchParams("kind=pr-sitter"),
  })
  assert.equal(boardless.status, 400)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getTaskDetail accepts any status folder an enabled kind declares", async () => {
  const dir = makeFixture()
  const tasks = path.join(dir, "docs", "tasks")
  fs.mkdirSync(path.join(tasks, "inbox"), { recursive: true })
  fs.writeFileSync(path.join(tasks, "inbox", "triage-me.md"), "---\ntitle: Triage me\n---\nBody.")
  const board: KindBoardInfo = {
    kind: "triage",
    description: "triage kind",
    sourceType: "backlog",
    statuses: ["inbox"],
    gateStatuses: [],
    pools: ["inbox"],
  }
  const res = await getTaskDetail(depsFor(dir, [board]), {
    params: { status: "inbox", id: "triage-me" },
    query: new URLSearchParams(),
  })
  assert.equal(res.status, 200)
  assert.equal((res.body as TaskDetailResponse).card.id, "triage-me")
  fs.rmSync(dir, { recursive: true, force: true })
})
