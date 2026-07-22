import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Worktree pinning in the BUILT check-stage-guard.mjs, driven end-to-end over
 * the hook contract (stdin JSON; exit 0 allows, exit 2 blocks, and exit 0 with
 * an `updatedInput` envelope on stdout rewrites the call): with a live worktree
 * marker, Bash is cd-pinned and edit paths are remapped onto the worktree, while
 * unreadable paths, paths under neither tree, and the worktree's frozen backlog
 * copy still fail closed.
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

/** The `updatedInput` a rewriting hook emitted, or null when it allowed as-is. */
const rewriteOf = (out) => {
  assert.equal(out.status, 0, out.stderr)
  if (!out.stdout.trim()) return null
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse")
  // The hook corrects the input; it must NOT also grant permission, or a
  // rewritten command would skip the prompt it would otherwise have faced.
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined)
  return parsed.hookSpecificOutput.updatedInput
}

const WT = path.join(os.tmpdir(), "wt-pin-worktree", "t")

test("bash without the cd-prefix is rewritten with it while a worktree stage is live", () => {
  const cwd = makeRepo(WT)
  assert.deepEqual(rewriteOf(run(cwd, "Bash", { command: "npm test" })), { command: `cd ${WT} && npm test` })
})

test("bash that explicitly leaves the worktree is still blocked", () => {
  const cwd = makeRepo(WT)
  const escape = run(cwd, "Bash", { command: `cd ${WT} && cd /elsewhere && rm -rf x` })
  assert.equal(escape.status, 2)
  assert.match(escape.stderr, /leaves it/)
  const write = run(cwd, "Bash", { command: `cd ${WT} && cp a.js /elsewhere/a.js` })
  assert.equal(write.status, 2)
  assert.match(write.stderr, /reaches \/elsewhere\/a\.js/)
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

test("a relative edit path is resolved against the worktree, not the session cwd", () => {
  const cwd = makeRepo(WT)
  assert.deepEqual(rewriteOf(run(cwd, "Edit", { file_path: "src/x.ts" })), { file_path: path.join(WT, "src", "x.ts") })
})

test("a main-tree edit path is remapped onto the worktree mirror", () => {
  // The reported symptom: the agent keeps making the change on the current branch.
  const cwd = makeRepo(WT)
  const out = run(cwd, "Edit", { file_path: path.join(cwd, "src", "x.ts"), old_string: "a", new_string: "b" })
  assert.deepEqual(rewriteOf(out), { file_path: path.join(WT, "src", "x.ts"), old_string: "a", new_string: "b" })
})

test("an unreadable edit path still fails closed", () => {
  const cwd = makeRepo(WT)
  const none = run(cwd, "Write", {})
  assert.equal(none.status, 2)
  assert.match(none.stderr, /could not be determined/)
})

test("edits already inside the worktree pass untouched; paths under neither tree are blocked", () => {
  const cwd = makeRepo(WT)
  assert.equal(rewriteOf(run(cwd, "Write", { file_path: path.join(WT, "src", "x.ts") })), null)
  const out = run(cwd, "Write", { file_path: "/somewhere/else/x.ts" })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /outside both it and the repo/)
})

test("a NotebookEdit is pinned like any other write", () => {
  const cwd = makeRepo(WT)
  assert.deepEqual(rewriteOf(run(cwd, "NotebookEdit", { notebook_path: "nb.ipynb" })), { notebook_path: path.join(WT, "nb.ipynb") })
})

test("an unisolated stage with a live loop worktree refuses code writes outright", () => {
  // engineering PLAN is `isolation: "none"`: no worktree to correct INTO, and a
  // code change there belongs to BUILD. Previously these were unguarded.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wt-pin-plan-"))
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  fs.writeFileSync(
    path.join(cwd, "docs", "tasks", "runs", ".stage.json"),
    JSON.stringify({ stage: "plan", taskId: "t", worktree: null, workflowWorktree: WT }),
  )
  const out = run(cwd, "Write", { file_path: path.join(cwd, "src", "x.ts") })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /PLAN stage does not build/)
})

test("the worktree's frozen backlog copy is off-limits even where the draft carve-out would allow it", () => {
  const cwd = makeRepo(WT)
  const out = run(cwd, "Write", { file_path: path.join(WT, "docs", "tasks", "draft", "new-idea.md") })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /driver-owned/)
})
