import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { machineIdSync } from "./src/marker.mjs"

/**
 * A CRASHED run's leftover stage marker must stop enforcing, end-to-end over
 * the BUILT check-stage-guard.mjs (stdin JSON; exit 0 allows, exit 2 blocks).
 *
 * Nothing removes `.stage.json` when the MCP server dies mid-stage (SIGKILL,
 * OOM, poweroff) — the deadline-starve block always knew that and failed open
 * on a dead writer, but every OTHER marker-scoped control kept enforcing the
 * leftover forever: every later session's bash starved behind the VERIFY
 * allowlist, the human's own `gh pr merge` blocked, main-tree edits silently
 * rewritten into a dead worktree, and a dead PLAN marker's carve-out kept a
 * stale queued/ write legal. The rule pinned here: a marker past its deadline
 * whose writer pid is gone reads as NO marker at all — while an expired marker
 * whose writer is still alive keeps the starve, and a live-deadline marker
 * keeps enforcing everything. Same reading `decideSpawnGuard` and core's
 * `taskDrivenByStageMarker` give an expired marker.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-stage-guard.mjs")

const makeRepo = (marker) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dead-marker-"))
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "queued"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", ".stage.json"), JSON.stringify(marker))
  return cwd
}

const run = (cwd, tool_name, tool_input) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, tool_name, tool_input }), encoding: "utf8" })

/** A pid that is certainly not running: spawned and reaped before we look. */
const reapedPid = () => {
  const out = execFileSync("sh", ["-c", "sh -c 'echo $$' & wait"], { encoding: "utf8" })
  const pid = Number(out.trim().split(/\s+/).pop())
  return Number.isInteger(pid) && pid > 0 ? pid : 999_999
}

/**
 * A writer stamp the hook can PROVE is a live process here: a pid is only
 * meaningful beside the machine identity that produced it, so the pid alone no
 * longer reads alive.
 */
const ours = () => ({ pid: process.pid, machine: machineIdSync() })

const READS = ["git status*", "git diff*", "ls*", "cat *", "npm test*"]
const EXPIRED = Date.now() - 60_000
const LIVE = Date.now() + 3_600_000

test("a dead VERIFY marker no longer starves bash behind the check-stage allowlist", () => {
  const dead = { stage: "verify", check: true, taskId: "t", worktree: null, bashAllowlist: READS, deadline: EXPIRED, pid: reapedPid() }
  assert.equal(run(makeRepo(dead), "Bash", { command: "make deploy" }).status, 0, "a crashed run's leftover must not rule the repo")

  const live = { ...dead, deadline: LIVE, pid: process.pid }
  const denied = run(makeRepo(live), "Bash", { command: "make deploy" })
  assert.equal(denied.status, 2, "a live marker keeps the allowlist")
  assert.match(denied.stderr, /not on its allowlist/)
})

test("an expired marker whose writer is STILL ALIVE keeps the deadline starve", () => {
  const overdue = { stage: "verify", check: true, taskId: "t", worktree: null, bashAllowlist: READS, deadline: EXPIRED, ...ours() }
  const starved = run(makeRepo(overdue), "Bash", { command: "git status" })
  assert.equal(starved.status, 2)
  assert.match(starved.stderr, /exceeded its stageTimeoutMinutes deadline/)
})

test("a live pid from ANOTHER pid namespace does not keep the starve alive", () => {
  // The wedge this file shipped to end, reopened one environment over: sibling
  // containers from one image share a hostname and this bind-mounted directory
  // while having separate pid namespaces, so a crashed writer's pid exists in
  // the next session's namespace and reads live. "Alive" is the reading that
  // ENFORCES, so it needs the pid's namespace, not just the pid.
  const foreign = {
    stage: "verify",
    check: true,
    taskId: "t",
    worktree: null,
    bashAllowlist: READS,
    deadline: EXPIRED,
    pid: process.pid,
    machine: { host: "some-other-box", boot: "00000000-0000-0000-0000-000000000000" },
  }
  assert.equal(run(makeRepo(foreign), "Bash", { command: "make deploy" }).status, 0, "an unprovable writer must not rule the repo")

  // An older server stamped no machine at all — same reading, same direction.
  const unstamped = { ...foreign, machine: undefined, pid: process.pid }
  assert.equal(run(makeRepo(unstamped), "Bash", { command: "make deploy" }).status, 0)
})

test("a dead BUILD marker no longer rewrites main-tree edits into its dead worktree", () => {
  const wt = path.join(os.tmpdir(), "dead-marker-worktree")
  const dead = { stage: "build", taskId: "t", worktree: wt, deadline: EXPIRED, pid: reapedPid() }
  const cwd = makeRepo(dead)
  const res = run(cwd, "Write", { file_path: path.join(cwd, "src", "a.ts"), content: "x" })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), "", "no updatedInput — the edit lands where the user aimed it")

  const live = { ...dead, deadline: LIVE, pid: process.pid }
  const cwd2 = makeRepo(live)
  const pinned = run(cwd2, "Write", { file_path: path.join(cwd2, "src", "a.ts"), content: "x" })
  assert.equal(pinned.status, 0)
  assert.match(pinned.stdout, /updatedInput/, "a live worktree loop still pins the edit")
})

test("a dead publish marker no longer blocks the human's own gh pr merge / git push", () => {
  const dead = { stage: "publish", taskId: "t", worktree: null, bashAllowlist: ["git push origin *", "gh api *"], deadline: EXPIRED, pid: reapedPid() }
  const cwd = makeRepo(dead)
  assert.equal(run(cwd, "Bash", { command: "gh pr merge 3" }).status, 0, "the loop is over — merging is the human's call again")
  assert.equal(run(cwd, "Bash", { command: "git push origin main" }).status, 0)
})

test("a dead PLAN marker's queued/ carve-out dies with it", () => {
  const dead = { stage: "plan", taskId: "t1", worktree: null, deadline: EXPIRED, pid: reapedPid() }
  const cwd = makeRepo(dead)
  const res = run(cwd, "Write", { file_path: path.join(cwd, "docs", "tasks", "queued", "t1.md"), content: "x" })
  assert.equal(res.status, 2, "the always-on backlog guard is back to default-deny")

  const live = { ...dead, deadline: LIVE, pid: process.pid }
  const cwd2 = makeRepo(live)
  assert.equal(run(cwd2, "Write", { file_path: path.join(cwd2, "docs", "tasks", "queued", "t1.md"), content: "x" }).status, 0)
})

test("a marker with no deadline (an older server) stays trusted", () => {
  const old = { stage: "verify", check: true, taskId: "t", worktree: null, bashAllowlist: READS }
  const denied = run(makeRepo(old), "Bash", { command: "make deploy" })
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /not on its allowlist/)
})
