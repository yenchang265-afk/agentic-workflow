import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { backlogRoot, isSameMachine, liveMarker, machineIdSync, markerWriterAlive, readTasksDir, runsDir } from "./src/marker.mjs"

/**
 * The guards must look for the stage marker exactly where the MCP server writes
 * it. When they didn't, `readMarker` returned null and the PreToolUse guard
 * allowed everything — before the deadline check, the worktree pin and the
 * VERIFY/REVIEW default-deny allowlist — while every layer reported success.
 */

const withEnv = (vars, run) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    run()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const tmp = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-tasksdir-"))
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return dir
}

test("tasksDir falls back to docs/tasks with no config anywhere", () => {
  const dir = tmp({})
  withEnv({ AGENTIC_WORKFLOW_USER_CONFIG: "" }, () => {
    assert.equal(readTasksDir(dir), "docs/tasks")
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a repo-layer tasksDir is honored", () => {
  const dir = tmp({ ".agentic-workflow.json": JSON.stringify({ tasksDir: "work/items" }) })
  withEnv({ AGENTIC_WORKFLOW_USER_CONFIG: "" }, () => {
    assert.equal(readTasksDir(dir), "work/items")
  })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a USER-layer tasksDir is honored — the layer the guards used to ignore", () => {
  // The documented user-scope layer, which verb-slice.mjs and inject-ado-pat.mjs
  // already read and the MCP server merges via loadConfig. The guards read only
  // the repo file, so the marker they looked for was never the one written.
  const userDir = tmp({ "agentic-workflow.json": JSON.stringify({ tasksDir: "user/tasks" }) })
  const repo = tmp({})
  withEnv({ AGENTIC_WORKFLOW_USER_CONFIG: path.join(userDir, "agentic-workflow.json") }, () => {
    assert.equal(readTasksDir(repo), "user/tasks")
  })
  fs.rmSync(userDir, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

test("the repo layer wins over the user layer, matching mergeConfigLayers", () => {
  const userDir = tmp({ "agentic-workflow.json": JSON.stringify({ tasksDir: "user/tasks" }) })
  const repo = tmp({ ".agentic-workflow.json": JSON.stringify({ tasksDir: "repo/tasks" }) })
  withEnv({ AGENTIC_WORKFLOW_USER_CONFIG: path.join(userDir, "agentic-workflow.json") }, () => {
    assert.equal(readTasksDir(repo), "repo/tasks")
  })
  fs.rmSync(userDir, { recursive: true, force: true })
  fs.rmSync(repo, { recursive: true, force: true })
})

test("AGENTIC_WORKFLOW_DIR overrides the session cwd, as it does in the server", () => {
  // A session started in a subdirectory (or with the env var pointed elsewhere)
  // must still resolve the backlog the server writes to.
  const repo = tmp({ ".agentic-workflow.json": JSON.stringify({ tasksDir: "docs/backlog" }) })
  withEnv({ AGENTIC_WORKFLOW_DIR: repo, AGENTIC_WORKFLOW_USER_CONFIG: "" }, () => {
    assert.equal(backlogRoot("/somewhere/else/src"), repo)
    assert.equal(runsDir("/somewhere/else/src"), path.join(repo, "docs/backlog", "runs"))
  })
  fs.rmSync(repo, { recursive: true, force: true })
})

test("a malformed config layer reads as absent rather than throwing", () => {
  const repo = tmp({ ".agentic-workflow.json": "{ not json" })
  withEnv({ AGENTIC_WORKFLOW_USER_CONFIG: "" }, () => {
    assert.equal(readTasksDir(repo), "docs/tasks")
  })
  fs.rmSync(repo, { recursive: true, force: true })
})

/** A marker stamped by this very process — the only shape that can read alive. */
const ours = (pid) => ({ pid, machine: machineIdSync() })

test("markerWriterAlive: a live pid reads alive; a gone, absent, or non-pid value reads dead", () => {
  // Our own pid is the self-validating probe: it must read alive, or the check
  // proves nothing. 999999999 is beyond every Linux pid_max default, so kill(2)
  // reports ESRCH. Everything non-pid-shaped (an older marker without the field,
  // a garbled value) reads dead — which the caller treats as fail OPEN.
  assert.equal(markerWriterAlive(ours(process.pid)), true)
  assert.equal(markerWriterAlive(ours(999_999_999)), false)
  assert.equal(markerWriterAlive(ours(undefined)), false)
  assert.equal(markerWriterAlive(ours(null)), false)
  assert.equal(markerWriterAlive(ours(0)), false)
  assert.equal(markerWriterAlive(ours(-1)), false)
  assert.equal(markerWriterAlive(ours(1.5)), false)
  assert.equal(markerWriterAlive(ours("123")), false)
  assert.equal(markerWriterAlive(undefined), false)
  assert.equal(markerWriterAlive(null), false)
})

test("a pid without its namespace proves nothing — the reading that ENFORCES needs proof", () => {
  // This is the direction core's `liveness.ts` refuses to bless the bare probe
  // for: "alive" here KEEPS the deadline starve, so a foreign pid that happens
  // to exist locally (sibling containers from one image, a bind-mounted repo)
  // would block Bash and Write repo-wide, addressed to nobody. Our own live pid
  // under someone else's namespace must therefore read dead.
  const self = machineIdSync()
  assert.equal(markerWriterAlive({ pid: process.pid, machine: { host: "some-other-box", boot: self.boot } }), false)
  assert.equal(markerWriterAlive({ pid: process.pid, machine: { host: self.host, boot: "00000000-0000-0000-0000-000000000000" } }), false)
  // An older server stamped no machine at all: not provably local, so not alive
  // — the fail-OPEN direction every uncertainty in these hooks takes.
  assert.equal(markerWriterAlive({ pid: process.pid }), false)
})

test("isSameMachine refuses every uncertainty, including a one-sided boot id", () => {
  const self = machineIdSync()
  assert.equal(isSameMachine(self, self), true)
  assert.equal(isSameMachine({ host: self.host }, { host: self.host, boot: "b" }), false)
  assert.equal(isSameMachine({ host: self.host, boot: "b" }, { host: self.host, boot: null }), false)
  assert.equal(isSameMachine({}, self), false)
  assert.equal(isSameMachine(null, self), false)
})

test("liveMarker is the one rule: expired + dead writer reads as NO marker", () => {
  const past = Date.now() - 60_000
  const future = Date.now() + 60_000
  const dead = { stage: "verify", deadline: past, ...ours(999_999_999) }
  const live = { stage: "verify", deadline: past, ...ours(process.pid) }
  assert.equal(liveMarker(dead), null)
  assert.equal(liveMarker(live), live, "an expired marker whose writer runs is a late loop, not a dead one")
  const future_ = { stage: "verify", deadline: future }
  assert.equal(liveMarker(future_), future_)
  const noDeadline = { stage: "verify" }
  assert.equal(liveMarker(noDeadline), noDeadline, "an older server's marker stays trusted")
  assert.equal(liveMarker(null), null)
})
