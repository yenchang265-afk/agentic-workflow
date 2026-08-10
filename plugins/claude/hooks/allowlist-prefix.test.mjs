import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `bashAllowlistPrefix` end-to-end over the BUILT check-stage-guard.mjs, driven
 * on the hook contract (stdin JSON; exit 0 allows, exit 2 blocks).
 *
 * Two halves, and the second is why the first is not enough. The marker's
 * `bashAllowlist` carries the stage's globs re-expressed behind the proxy
 * (`npm test*` → also `rtk npm test*`), which is what keeps a rewritten command
 * from starving on a shape no glob matches — but every write backstop anchors on
 * the BARE tool name, so `rtk git push --force origin main` matches its derived
 * glob quite legitimately and would sail past the classifier that knows `main` is
 * protected. The marker's `bashPrefix` is what the guard strips before
 * classifying. A marker without it behaves exactly as an older server's did.
 *
 * This is also the only coverage that drives the marker's `bashAllowlist` field
 * through the guard at all; everything else pins `commandAllowed` directly.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-stage-guard.mjs")

const makeRepo = (marker) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "allow-prefix-"))
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", ".stage.json"), JSON.stringify(marker))
  return cwd
}

const run = (cwd, command) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } }), encoding: "utf8" })

const READS = ["git status*", "git diff*", "ls*", "cat *", "find *", "npm test*"]
const PUSH = ["git push origin *", "git status*", "gh pr comment *", "gh pr view*", "gh api *"]
/** What the MCP server stamps: the stage's globs, plus one variant per prefix. */
const prefixed = (globs, prefix) => [...globs, ...globs.map((g) => `${prefix} ${g}`)]

const verifyMarker = (extra) => ({ stage: "verify", check: true, taskId: "t", worktree: null, ...extra })

test("a rewritten command runs on the stage's own globs, and one it never had is still refused", () => {
  const cwd = makeRepo(verifyMarker({ bashAllowlist: prefixed(READS, "rtk"), bashPrefix: ["rtk"] }))
  assert.equal(run(cwd, "rtk npm test").status, 0)
  assert.equal(run(cwd, "rtk git status --short").status, 0)
  assert.equal(run(cwd, "npm test").status, 0, "the unrewritten form keeps working")
  const denied = run(cwd, "rtk npm publish")
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /not on its allowlist/)
})

test("the guard strips the prefix before the read-only find classifier", () => {
  const cwd = makeRepo(verifyMarker({ bashAllowlist: prefixed(READS, "rtk"), bashPrefix: ["rtk"] }))
  assert.equal(run(cwd, "rtk find . -name '*.ts'").status, 0)
  const mutation = run(cwd, "rtk find . -delete")
  assert.equal(mutation.status, 2, "`rtk find . -delete` matches `rtk find *` — only the strip catches it")
  assert.match(mutation.stderr, /not on its allowlist/)
})

test("the guard strips the prefix before the push and PR-mutation backstops", () => {
  const cwd = makeRepo({ stage: "publish", taskId: "t", worktree: null, bashAllowlist: prefixed(PUSH, "rtk"), bashPrefix: ["rtk"] })
  assert.equal(run(cwd, "rtk git push origin feature/x").status, 0, "the sitter's own head still pushes")
  // Both vectors are ON the derived allowlist — `rtk git push origin main`
  // matches `rtk git push origin *` and the merge call matches `rtk gh api *`.
  // Narrowing the allowlist can never catch these; only the classifiers know
  // that `main` is protected and that a PUT to /merge is a state change.
  const protectedBranch = run(cwd, "rtk git push origin main")
  assert.equal(protectedBranch.status, 2)
  assert.match(protectedBranch.stderr, /never push a branch other than its own head/)
  const merge = run(cwd, "rtk gh api -X PUT repos/o/r/pulls/3/merge")
  assert.equal(merge.status, 2)
  assert.match(merge.stderr, /never mutate a pull request/)
})

test("a marker without bashPrefix is exactly the previous behaviour — fail open, never a stall", () => {
  const cwd = makeRepo({ stage: "publish", taskId: "t", worktree: null, bashAllowlist: prefixed(PUSH, "rtk") })
  // The gap this change closes, pinned as it was: the allowlist admits the
  // rewritten push and the classifier, anchored on `^git … push`, never sees it.
  // Left fail-open on purpose — that is the direction every uncertain marker
  // input takes here, since a false deny wedges a run with no way out while a
  // false allow only restores the old state.
  assert.equal(run(cwd, "rtk git push origin main").status, 0)
  // The unrewritten form is unaffected by any of this.
  assert.equal(run(cwd, "git push origin main").status, 2)
})
