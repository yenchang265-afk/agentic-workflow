import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { GateResult, KindBoardInfo } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { postPlanRequest, postPlanRequestCancel } from "./plan-request.js"

/**
 * The plan-request route, against a real git repo and real task files — the same
 * fixture shape as gate.test.ts, for the opposite reason. There the point is
 * that the ops commit; here the point is that this one MUST NOT, and only a real
 * repo can show that HEAD did not move. `ignoreBacklog: false` is kept for that:
 * with committing switched on, a stray commit would be visible.
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

const TASK = (id: string, title: string, withPlan: boolean): string =>
  [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: feature",
    "priority: 2",
    "acceptance:",
    "  - it works",
    "---",
    "",
    "Some body.",
    ...(withPlan ? ["", "## Implementation Plan", "", "1. Do the thing."] : []),
    "",
  ].join("\n")

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-planreq-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  for (const s of ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"]) {
    fs.mkdirSync(path.join(dir, "docs", "tasks", s), { recursive: true })
  }
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

const place = (dir: string, status: string, id: string, withPlan = false): void => {
  fs.writeFileSync(path.join(dir, "docs", "tasks", status, `${id}.md`), TASK(id, `task ${id}`, withPlan))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", `add ${id}`)
}

/** Whether a plan-request marker exists for `id`. */
const requested = (dir: string, id: string): boolean =>
  fs.existsSync(path.join(dir, "docs", "tasks", "queued", ".requests", id))

const hold = (dir: string, status: string, id: string): void => {
  fs.mkdirSync(path.join(dir, "docs", "tasks", status, ".claims", id), { recursive: true })
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  config: { ...DEFAULT_CONFIG, ignoreBacklog: false },
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const ask = async (deps: HubDeps, body: unknown): Promise<JsonResponse> =>
  postPlanRequest(deps, { params: {}, query: new URLSearchParams(), body })

const cancel = async (deps: HubDeps, body: unknown): Promise<JsonResponse> =>
  postPlanRequestCancel(deps, { params: {}, query: new URLSearchParams(), body })

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

const headMessage = (dir: string): string => execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir }).toString().trim()

test("a plan request writes a marker and commits NOTHING — that is what keeps the hub a caller, not a driver", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const before = headMessage(dir)

  const res = await ask(depsFor(dir), { id: "t1", expectStatus: "queued" })
  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(requested(dir, "t1"))
  assert.equal(headMessage(dir), before, "no commit may land: a request is coordination state, not a lifecycle fact")
  assert.match((res.body as GateResult).message, /Nothing runs until then/, "the copy must not imply something started")
  cleanup(dir)
})

test("cancel removes the marker, and cancelling again still succeeds — a double-click is not an error", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const deps = depsFor(dir)
  await ask(deps, { id: "t1", expectStatus: "queued" })

  const first = await cancel(deps, { id: "t1", expectStatus: "queued" })
  assert.equal((first.body as GateResult).ok, true)
  assert.equal(requested(dir, "t1"), false)

  const second = await cancel(deps, { id: "t1", expectStatus: "queued" })
  assert.equal(second.status, 200)
  assert.equal((second.body as GateResult).ok, true)
  assert.match((second.body as GateResult).message, /nothing to withdraw/)
  cleanup(dir)
})

test("requesting twice is one request — the marker is restamped, not duplicated", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const deps = depsFor(dir)
  await ask(deps, { id: "t1", expectStatus: "queued" })
  await ask(deps, { id: "t1", expectStatus: "queued" })
  assert.deepEqual(fs.readdirSync(path.join(dir, "docs", "tasks", "queued", ".requests")), ["t1"])
  cleanup(dir)
})

test("a stale board is refused with 409 naming where the task actually is", async () => {
  const dir = makeRepo()
  place(dir, "plan-review", "t1")
  const res = await ask(depsFor(dir), { id: "t1", expectStatus: "queued" })
  assert.equal(res.status, 409)
  assert.match((res.body as { error: string }).error, /is in plan-review, not queued/)
  assert.equal(requested(dir, "t1"), false)
  cleanup(dir)
})

test("a queued task that already carries a plan is refused, pointing at Replan", async () => {
  // Planning it again would append a SECOND ## Implementation Plan, and
  // extractPlan reads the last — the older one would silently stop existing.
  const dir = makeRepo()
  place(dir, "queued", "t1", true)
  const res = await ask(depsFor(dir), { id: "t1", expectStatus: "queued" })
  assert.equal(res.status, 200, "a domain refusal is data, not a transport error")
  assert.equal((res.body as GateResult).ok, false)
  assert.match((res.body as GateResult).message, /already carries a plan/)
  assert.equal(requested(dir, "t1"), false)
  cleanup(dir)
})

test("a task a loop is already driving is refused rather than silently no-op'd", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  hold(dir, "queued", "t1")
  const res = await ask(depsFor(dir), { id: "t1", expectStatus: "queued" })
  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, false)
  assert.match((res.body as GateResult).message, /being driven right now/)
  cleanup(dir)
})

test("cancel is allowed on a driven task — withdrawing an ask must always work", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const deps = depsFor(dir)
  await ask(deps, { id: "t1", expectStatus: "queued" })
  hold(dir, "queued", "t1")

  const res = await cancel(deps, { id: "t1", expectStatus: "queued" })
  assert.equal((res.body as GateResult).ok, true)
  assert.equal(requested(dir, "t1"), false)
  cleanup(dir)
})

test("malformed requests are rejected before anything touches the filesystem", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const deps = depsFor(dir)

  assert.equal((await ask(deps, { id: "../../etc/passwd", expectStatus: "queued" })).status, 400)
  assert.equal((await ask(deps, { expectStatus: "queued" })).status, 400)
  // Only the planless column can be requested from; a draft has no plan to ask for.
  assert.equal((await ask(deps, { id: "t1", expectStatus: "draft" })).status, 400)
  assert.equal(fs.existsSync(path.join(dir, "docs", "tasks", "queued", ".requests")), false)
  cleanup(dir)
})

test("two concurrent requests serialize on the gate lock and leave one marker", async () => {
  const dir = makeRepo()
  place(dir, "queued", "t1")
  const deps = depsFor(dir)
  const [a, b] = await Promise.all([
    ask(deps, { id: "t1", expectStatus: "queued" }),
    ask(deps, { id: "t1", expectStatus: "queued" }),
  ])
  assert.equal(a?.status, 200)
  assert.equal(b?.status, 200)
  assert.deepEqual(fs.readdirSync(path.join(dir, "docs", "tasks", "queued", ".requests")), ["t1"])
  cleanup(dir)
})
