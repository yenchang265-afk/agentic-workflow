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
import { postGate, withGateLock } from "./gate.js"

/**
 * The gate routes, against a real git repo and real task files — these ops
 * commit, so a fixture that fakes the shell would prove nothing about the thing
 * most worth proving.
 *
 * No network, and no shell stub needed to guarantee it: core's shipPr no-ops
 * unless a `feature/<id>` branch exists, and with one it pushes before it ever
 * reaches `gh`. The fixture repo has no remote, so the push fails locally and
 * the "no PR opened" path runs for real.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-gate-"))
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

const at = (dir: string, status: string, id: string): boolean =>
  fs.existsSync(path.join(dir, "docs", "tasks", status, `${id}.md`))

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  // ignoreBacklog defaults to true; these tests assert the commit itself, so
  // opt back into committing (see packages/core/src/workflow/gate.ts).
  config: { ...DEFAULT_CONFIG, ignoreBacklog: false },
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const gate = async (deps: HubDeps, action: string, body: unknown): Promise<JsonResponse> =>
  postGate(deps, { params: { action }, query: new URLSearchParams(), body })

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

const headMessage = (dir: string): string => execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir }).toString().trim()

test("approve-task moves a draft to queued and commits", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing")
  const res = await gate(depsFor(dir), "approve-task", { id: "aaa1-thing", expectStatus: "draft" })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "queued", "aaa1-thing") && !at(dir, "draft", "aaa1-thing"))
  assert.match(headMessage(dir), /task approved/)
  cleanup(dir)
})

test("approve-plan moves a plan-review task to in-progress and commits", async () => {
  const dir = makeRepo()
  place(dir, "plan-review", "bbb2-thing", true)
  const res = await gate(depsFor(dir), "approve-plan", { id: "bbb2-thing", expectStatus: "plan-review" })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "in-progress", "bbb2-thing"))
  assert.match(headMessage(dir), /plan approved/)
  cleanup(dir)
})

test("replan sends a parked plan back to queued, carrying the reason into the audit note", async () => {
  const dir = makeRepo()
  place(dir, "plan-review", "ccc3-thing", true)
  const res = await gate(depsFor(dir), "replan", {
    id: "ccc3-thing",
    expectStatus: "plan-review",
    reason: "misses the cache path",
  })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "queued", "ccc3-thing"))
  assert.match(fs.readFileSync(path.join(dir, "docs", "tasks", "queued", "ccc3-thing.md"), "utf8"), /misses the cache path/)
  cleanup(dir)
})

test("ship completes a task that has no feature branch, without attempting a PR", async () => {
  const dir = makeRepo()
  place(dir, "in-review", "ddd4-thing", true)
  const res = await gate(depsFor(dir), "ship", { id: "ddd4-thing", expectStatus: "in-review" })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "completed", "ddd4-thing"))
  // shipPr no-ops without a feature/<id> branch (a hand-authored task), and a
  // silent no-op must stay silent — no misleading "PR not opened" note.
  const body = fs.readFileSync(path.join(dir, "docs", "tasks", "completed", "ddd4-thing.md"), "utf8")
  assert.doesNotMatch(body, /PR not opened/)
  cleanup(dir)
})

test("ship completes even when the PR fails, and records the failure rather than swallowing it", async () => {
  const dir = makeRepo()
  place(dir, "in-review", "ddd5-thing", true)
  // A feature branch makes shipPr attempt for real. The fixture has no remote,
  // so the push fails locally — no network, and the failure path runs genuinely.
  git(dir, "branch", "feature/ddd5-thing")

  const res = await gate(depsFor(dir), "ship", { id: "ddd5-thing", expectStatus: "in-review" })
  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "completed", "ddd5-thing"), "the ship must not depend on the PR succeeding")
  const body = fs.readFileSync(path.join(dir, "docs", "tasks", "completed", "ddd5-thing.md"), "utf8")
  assert.match(body, /PR not opened/, "a failed PR must leave a trace")
  cleanup(dir)
})

test("a stale board is refused with 409, naming where the task actually is", async () => {
  const dir = makeRepo()
  // The client thinks it's in-review; it has already moved on.
  place(dir, "completed", "eee5-thing", true)
  const res = await gate(depsFor(dir), "ship", { id: "eee5-thing", expectStatus: "in-review" })

  assert.equal(res.status, 409)
  const body = res.body as { error: string; actual?: string }
  assert.equal(body.actual, "completed")
  assert.match(body.error, /stale/)
  cleanup(dir)
})

test("replan is refused while the task holds a claim — a live loop is driving it", async () => {
  const dir = makeRepo()
  place(dir, "plan-review", "fff6-thing", true)
  // A claim marker in a pool status: something is driving this task right now.
  fs.mkdirSync(path.join(dir, "docs", "tasks", "in-progress", ".claims", "fff6-thing"), { recursive: true })

  const res = await gate(depsFor(dir), "replan", { id: "fff6-thing", expectStatus: "plan-review" })
  assert.equal(res.status, 200, "a refusal is a domain outcome, not a transport error")
  const body = res.body as GateResult
  assert.equal(body.ok, false)
  assert.match(body.message, /live loop|driven/i)
  assert.ok(at(dir, "plan-review", "fff6-thing"), "the task must not move")
  cleanup(dir)
})

test("a refusal keeps its variant — the info-vs-warning distinction survives the wire", async () => {
  const dir = makeRepo()
  place(dir, "draft", "ggg7-thing")
  // Approving a draft as though it were a plan-review task: wrong gate for the folder.
  const res = await gate(depsFor(dir), "approve-plan", { id: "ggg7-thing", expectStatus: "plan-review" })
  // expectStatus catches it first — that's the point of the guard.
  assert.equal(res.status, 409)

  // Now the genuine domain refusal: an epic can never be approved.
  const dir2 = makeRepo()
  fs.writeFileSync(
    path.join(dir2, "docs", "tasks", "draft", "hhh8-epic.md"),
    TASK("hhh8-epic", "an epic", false).replace("type: feature", "type: epic"),
  )
  git(dir2, "add", "-A")
  git(dir2, "commit", "-qm", "add epic")
  const res2 = await gate(depsFor(dir2), "approve-task", { id: "hhh8-epic", expectStatus: "draft" })
  assert.equal(res2.status, 200)
  const body2 = res2.body as GateResult
  assert.equal(body2.ok, false)
  assert.equal(body2.ok === false && body2.variant, "warning")
  assert.ok(at(dir2, "draft", "hhh8-epic"))
  cleanup(dir)
  cleanup(dir2)
})

test("malformed requests are rejected before anything touches the filesystem", async () => {
  const dir = makeRepo()
  const deps = depsFor(dir)

  assert.equal((await gate(deps, "nope", { id: "a", expectStatus: "draft" })).status, 400)
  assert.equal((await gate(deps, "approve-task", { id: "../../etc/passwd", expectStatus: "draft" })).status, 400)
  assert.equal((await gate(deps, "approve-task", {})).status, 400)
  // approve-task only ever applies to a draft; naming another origin is a bug in the caller.
  assert.equal((await gate(deps, "approve-task", { id: "aaa1-thing", expectStatus: "completed" })).status, 400)
  cleanup(dir)
})

test("replan also accepts a cap-tripped in-progress task — its second valid origin", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "iii9-thing", true)
  const res = await gate(depsFor(dir), "replan", { id: "iii9-thing", expectStatus: "in-progress" })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(at(dir, "queued", "iii9-thing"))
  cleanup(dir)
})

test("two concurrent gates on one task: the second re-checks after the first moved and 409s", async () => {
  // The double-click TOCTOU: both requests pass the stale-board check, both
  // move. The per-repo lock forces the second confirm to run AFTER the first
  // move, so it sees the new folder and refuses.
  const dir = makeRepo()
  place(dir, "draft", "ddd1-thing")
  const deps = depsFor(dir)
  const [a, b] = await Promise.all([
    gate(deps, "approve-task", { id: "ddd1-thing", expectStatus: "draft" }),
    gate(deps, "approve-task", { id: "ddd1-thing", expectStatus: "draft" }),
  ])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [200, 409], `expected exactly one winner, got ${a.status}/${b.status}`)
  assert.ok(at(dir, "queued", "ddd1-thing"))
  cleanup(dir)
})

test("withGateLock serializes per directory and keeps different directories concurrent", async () => {
  const order: string[] = []
  const step = (name: string, ms: number) => () =>
    new Promise<string>((resolve) =>
      setTimeout(() => {
        order.push(name)
        resolve(name)
      }, ms),
    )
  await Promise.all([withGateLock("/same", step("first", 30)), withGateLock("/same", step("second", 1))])
  assert.deepEqual(order, ["first", "second"], "same repo: the later call waits despite being faster")

  order.length = 0
  await Promise.all([withGateLock("/one", step("slow", 30)), withGateLock("/two", step("fast", 1))])
  assert.deepEqual(order, ["fast", "slow"], "different repos stay concurrent")

  await assert.rejects(withGateLock("/same", () => Promise.reject(new Error("veto"))))
  order.length = 0
  await withGateLock("/same", step("after-reject", 1))
  assert.deepEqual(order, ["after-reject"], "a rejected gate does not wedge the chain")
})
