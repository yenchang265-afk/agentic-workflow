import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Worktree pinning in the BUILT check-stage-guard.mjs, driven end-to-end over
 * the hook contract (stdin JSON; exit 0 allows, exit 2 blocks): with a live
 * worktree marker, Bash must be cd-pinned and edit tools must fail closed on
 * relative/unreadable paths and on the worktree's frozen backlog copy.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-stage-guard.mjs")

const makeRepo = (worktree) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wt-pin-"))
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, "docs", "tasks", "runs", ".stage.json"),
    JSON.stringify({ stage: "build", taskId: "t", worktree }),
  )
  return cwd
}

const run = (cwd, tool_name, tool_input) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, tool_name, tool_input }), encoding: "utf8" })

const WT = path.join(os.tmpdir(), "wt-pin-worktree", "t")

test("bash without the cd-prefix is blocked while a worktree stage is live", () => {
  const cwd = makeRepo(WT)
  const out = run(cwd, "Bash", { command: "npm test" })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /would run in the main tree/)
})

test("cd-pinned bash and read-only bash are allowed", () => {
  const cwd = makeRepo(WT)
  assert.equal(run(cwd, "Bash", { command: `cd ${WT} && npm test` }).status, 0)
  assert.equal(run(cwd, "Bash", { command: "git status" }).status, 0)
})

test("no worktree in the marker → bash untouched", () => {
  const cwd = makeRepo(null)
  assert.equal(run(cwd, "Bash", { command: "npm test" }).status, 0)
})

test("relative and unreadable edit paths fail closed under isolation", () => {
  const cwd = makeRepo(WT)
  const rel = run(cwd, "Edit", { file_path: "src/x.ts" })
  assert.equal(rel.status, 2)
  assert.match(rel.stderr, /relative path/)
  const none = run(cwd, "Write", {})
  assert.equal(none.status, 2)
  assert.match(none.stderr, /could not be determined/)
})

test("edits inside the worktree pass; outside are blocked", () => {
  const cwd = makeRepo(WT)
  assert.equal(run(cwd, "Write", { file_path: path.join(WT, "src", "x.ts") }).status, 0)
  const out = run(cwd, "Write", { file_path: "/somewhere/else/x.ts" })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /outside it/)
})

test("the worktree's frozen backlog copy is off-limits even where the draft carve-out would allow it", () => {
  const cwd = makeRepo(WT)
  const out = run(cwd, "Write", { file_path: path.join(WT, "docs", "tasks", "draft", "new-idea.md") })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /driver-owned/)
})
