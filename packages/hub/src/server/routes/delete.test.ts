import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-loop/core/config"
import type { DeletePreview, GateResult, KindBoardInfo } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { getDeletePreview, postDelete } from "./delete.js"

/**
 * The delete routes, against a real git repo — the removal commits, and the
 * refusals depend on what git actually says about a branch, so a stubbed shell
 * would prove nothing about the part worth proving.
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

const TASK = (id: string, title: string, extra: readonly string[] = [], body = "Some body."): string =>
  ["---", `id: ${id}`, `title: ${title}`, "priority: 2", "acceptance:", "  - it works", ...extra, "---", "", body, ""].join("\n")

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-delete-"))
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

const place = (dir: string, status: string, id: string, extra: readonly string[] = [], body = "Some body."): void => {
  fs.writeFileSync(path.join(dir, "docs", "tasks", status, `${id}.md`), TASK(id, `task ${id}`, extra, body))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", `add ${id}`)
}

const at = (dir: string, status: string, id: string): boolean =>
  fs.existsSync(path.join(dir, "docs", "tasks", status, `${id}.md`))

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  config: DEFAULT_CONFIG,
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const del = async (deps: HubDeps, id: string, body: unknown): Promise<JsonResponse> =>
  postDelete(deps, { params: { id }, query: new URLSearchParams(), body })

const preview = async (deps: HubDeps, id: string): Promise<JsonResponse> =>
  getDeletePreview(deps, { params: { id }, query: new URLSearchParams(), body: undefined })

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

test("delete removes a plain task and commits the removal", async () => {
  const dir = makeRepo()
  place(dir, "draft", "aaa1-thing")

  const res = await del(depsFor(dir), "aaa1-thing", { id: "aaa1-thing", expectStatus: "draft" })

  assert.equal(res.status, 200)
  assert.equal((res.body as GateResult).ok, true)
  assert.ok(!at(dir, "draft", "aaa1-thing"), "task file gone")
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir }).toString()
  assert.ok(!tracked.includes("aaa1-thing"), "the removal is committed, not left staged")
  cleanup(dir)
})

test("a traversal id is rejected before it reaches the filesystem", async () => {
  const dir = makeRepo()
  const res = await del(depsFor(dir), "../../etc/passwd", { id: "../../etc/passwd", expectStatus: "draft" })
  assert.equal(res.status, 400)
  cleanup(dir)
})

test("a stale board 409s with the task's real status, and deletes nothing", async () => {
  const dir = makeRepo()
  place(dir, "queued", "bbb2-thing")

  const res = await del(depsFor(dir), "bbb2-thing", { id: "bbb2-thing", expectStatus: "draft" })

  assert.equal(res.status, 409)
  assert.equal((res.body as { actual?: string }).actual, "queued")
  assert.ok(at(dir, "queued", "bbb2-thing"), "a stale click must not delete")
  cleanup(dir)
})

test("a domain refusal is a 200 carrying ok:false, and leaves the task in place", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "ccc3-thing")
  // A branch whose commit exists nowhere else — the blocker core refuses on.
  git(dir, "checkout", "-q", "-b", "feature/ccc3-thing")
  fs.writeFileSync(path.join(dir, "work.txt"), "unmerged\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "build: work")
  git(dir, "checkout", "-q", "-")

  const res = await del(depsFor(dir), "ccc3-thing", { id: "ccc3-thing", expectStatus: "in-progress" })

  // 200, not 4xx: the browser's parse() throws on !res.ok and would lose the message.
  assert.equal(res.status, 200)
  const body = res.body as GateResult
  assert.equal(body.ok, false)
  assert.match(body.message, /exist nowhere else/)
  assert.ok(at(dir, "in-progress", "ccc3-thing"), "a refusal deletes nothing")

  // …and force gets past it.
  const forced = await del(depsFor(dir), "ccc3-thing", { id: "ccc3-thing", expectStatus: "in-progress", force: true })
  assert.equal((forced.body as GateResult).ok, true)
  assert.ok(!at(dir, "in-progress", "ccc3-thing"), "force deletes")
  cleanup(dir)
})

test("the preview reports blockers without deleting anything", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "ddd4-thing")
  git(dir, "checkout", "-q", "-b", "feature/ddd4-thing")
  fs.writeFileSync(path.join(dir, "work.txt"), "unmerged\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "build: work")
  git(dir, "checkout", "-q", "-")

  const res = await preview(depsFor(dir), "ddd4-thing")

  assert.equal(res.status, 200)
  const body = res.body as DeletePreview
  assert.equal(body.branchExists, true)
  assert.equal(body.unmergedCommits, 1)
  assert.ok(body.blockers.length > 0)
  assert.ok(at(dir, "in-progress", "ddd4-thing"), "a preview is read-only")
  cleanup(dir)
})

test("the preview lists an epic's child slices", async () => {
  const dir = makeRepo()
  place(dir, "draft", "eee5-epic", ["type: epic"], "Slices below.")
  place(dir, "draft", "fff6-one", [], "Part of epic: eee5-epic (slice 1 of 2)")
  place(dir, "draft", "ggg7-two", [], "Part of epic: eee5-epic (slice 2 of 2)")

  const res = await preview(depsFor(dir), "eee5-epic")

  assert.equal(res.status, 200)
  const body = res.body as DeletePreview
  assert.equal(body.isEpic, true)
  assert.deepEqual(
    body.children.map((c) => c.id).sort(),
    ["fff6-one", "ggg7-two"],
  )
  cleanup(dir)
})

test("an unknown id previews as 404", async () => {
  const dir = makeRepo()
  const res = await preview(depsFor(dir), "zzz9-nope")
  assert.equal(res.status, 404)
  cleanup(dir)
})
