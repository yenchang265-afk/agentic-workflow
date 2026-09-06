import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { KindBoardInfo, ReviewDiffResponse, ReviewResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getReview, getReviewDiff } from "./review.js"

/**
 * The ship gate's evidence (design 58), against a real git repo: the review
 * queue carries the run's suggestions note, and the diff route renders the
 * `base...branch` diff the done note names — capped, and never from the request.
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

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim()

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-review-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  for (const s of BOARDS[0]!.statuses) fs.mkdirSync(path.join(dir, "docs", "tasks", s), { recursive: true })
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

const STAMP = "[2026-01-01T00:00:00.000Z by loop]"
const DONE = "> Loop done — review passed on branch feature/t1, base main, awaiting human diff review; diff: 1 file changed, 2 insertions(+) " + STAMP

const parked = (dir: string, notes: readonly string[]): void => {
  fs.writeFileSync(
    path.join(dir, "docs", "tasks", "in-review", "t1.md"),
    ["---", "title: T1", "---", "", "Body.", "", "## Implementation Plan", "", "1. Go.", "", ...notes, ""].join("\n"),
  )
}

/** A feature branch with one commit on top of main, main left where it was. */
const branchWithWork = (dir: string): void => {
  git(dir, "checkout", "-q", "-b", "feature/t1")
  fs.writeFileSync(path.join(dir, "src.txt"), "line one\nline two\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "work")
  git(dir, "checkout", "-q", "main")
}

const depsFor = (directory: string, maxDiffLines?: number): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  config: {
    ...DEFAULT_CONFIG,
    workflows: { ...DEFAULT_CONFIG.workflows, engineering: { ...DEFAULT_CONFIG.workflows["engineering"], ...(maxDiffLines ? { maxDiffLines } : {}) } },
  },
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

const diff = (deps: HubDeps, status: string, id: string) => getReviewDiff(deps, { params: { status, id }, query: new URLSearchParams() })

test("the review queue carries the run's suggestions note, which the done note hides from lastEvent", async () => {
  const dir = makeRepo()
  try {
    parked(dir, [`> Review suggestions (2) — correctness: guard the null (src.txt:1); docs: mention it ${STAMP}`, DONE])
    const res = await getReview(depsFor(dir))
    const body = res.body as ReviewResponse
    const item = body.items.find((i) => i.card.id === "t1")
    assert.ok(item)
    assert.equal(item.lastEvent?.startsWith("Loop done"), true, "the done note stays the trail's newest line")
    assert.deepEqual(item.suggestions, { count: 2, text: "correctness: guard the null (src.txt:1); docs: mention it" })
    assert.equal(item.branch, "feature/t1")
    parked(dir, [DONE])
    const none = (await getReview(depsFor(dir))).body as ReviewResponse
    assert.equal(none.items.find((i) => i.card.id === "t1")?.suggestions, null)
  } finally {
    cleanup(dir)
  }
})

test("the diff route renders base...branch off the done note, capped by the kind's maxDiffLines", async () => {
  const dir = makeRepo()
  try {
    branchWithWork(dir)
    parked(dir, [DONE])
    const res = await diff(depsFor(dir), "in-review", "t1")
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const body = res.body as ReviewDiffResponse
    assert.equal(body.branch, "feature/t1")
    assert.equal(body.base, "main")
    assert.equal(body.diffCmd, "git diff main...feature/t1")
    assert.match(body.text, /\+line one\n\+line two/)
    assert.equal(body.truncated, false)
    assert.equal(body.maxLines, 2000)
    const capped = (await diff(depsFor(dir, 3), "in-review", "t1")).body as ReviewDiffResponse
    assert.equal(capped.truncated, true)
    assert.equal(capped.maxLines, 3)
    assert.equal(capped.text.split("\n").length, 3)
    assert.equal(capped.lines, body.lines)
  } finally {
    cleanup(dir)
  }
})

test("the diff route refuses a task with no recorded run, a gone branch, an unsafe id and an unknown status", async () => {
  const dir = makeRepo()
  try {
    parked(dir, ["> Plan written — parked for plan review " + STAMP])
    const none = await diff(depsFor(dir), "in-review", "t1")
    assert.equal(none.status, 409)
    assert.match((none.body as { error: string }).error, /no completed run/)
    parked(dir, [DONE]) // names feature/t1, which was never cut
    const gone = await diff(depsFor(dir), "in-review", "t1")
    assert.equal(gone.status, 409)
    assert.match((gone.body as { error: string }).error, /refs are gone/)
    assert.equal((await diff(depsFor(dir), "in-review", "../t1")).status, 400)
    assert.equal((await diff(depsFor(dir), "nowhere", "t1")).status, 400)
    assert.equal((await diff(depsFor(dir), "in-review", "t9")).status, 404)
  } finally {
    cleanup(dir)
  }
})
