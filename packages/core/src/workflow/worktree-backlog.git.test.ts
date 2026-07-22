import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Log, Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import type { WorkflowState } from "./state.js"
import { commitAll } from "./git.js"
import { ensureIsolation } from "./isolate.js"

/**
 * Real-git regression for the backlog's presence in a loop's worktree.
 *
 * `<tasksDir>/` is tracked, so `git worktree add` checks a frozen copy of every
 * task file into the worktree. Stage agents read that copy as the live backlog
 * and try to edit it — the reported "the task is cloned into the worktree"
 * confusion. `ensureIsolation` now sparse-checks it out, which the in-memory
 * isolate tests can't observe (their fake shell has no real worktrees).
 */

// A minimal bash-backed Shell — same harness as worktree-reuse.git.test.ts
// (copied rather than imported; core tests must not reach into a plugin's shim).
const esc = (v: unknown): string => `'${String(v).replace(/'/g, "'\\''")}'`
const isRaw = (v: unknown): v is { raw: string } => typeof v === "object" && v !== null && "raw" in v
const sh: Shell = (strings, ...exprs) => {
  let cmd = ""
  strings.forEach((s, i) => {
    if (i < exprs.length) {
      const e: unknown = exprs[i]
      cmd += s + (isRaw(e) ? e.raw : Array.isArray(e) ? e.map(esc).join(" ") : esc(e))
    } else cmd += s
  })
  let cwd: string | undefined
  const exec = (): Promise<ShellOutput> =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", cmd], { cwd })
      let out = ""
      let err = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (err += d))
      child.on("error", () => resolve({ exitCode: 127, stdout: { toString: () => out }, stderr: { toString: () => err || "spawn error" } }))
      child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout: { toString: () => out }, stderr: { toString: () => err } }))
    })
  const chain = {
    quiet: () => chain,
    nothrow: () => chain,
    cwd: (dir: string) => {
      cwd = dir
      return chain
    },
    then: <T1, T2>(onfulfilled?: ((v: ShellOutput) => T1 | PromiseLike<T1>) | null, onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null) =>
      exec().then(onfulfilled, onrejected),
  }
  return chain as ReturnType<Shell>
}

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const out = await sh`git -C ${repo} ${args}`.quiet().nothrow()
  assert.equal(out.exitCode, 0, `git ${args.join(" ")} failed: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

const noopLog: Log = () => {}
const config = { ...DEFAULT_CONFIG, worktreesDir: ".workflow-worktrees" }

const entryState = (taskPath: string): WorkflowState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id: "t1", path: taskPath, acceptance: [] },
})

const seedRepo = async (): Promise<{ repo: string; taskPath: string }> => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-workflow-backlog-")))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Backlog Test")
  const taskDirAbs = path.join(repo, config.tasksDir, "in-progress")
  fs.mkdirSync(taskDirAbs, { recursive: true })
  const taskPath = path.join(taskDirAbs, "t1.md")
  fs.writeFileSync(taskPath, serializeTask({ title: "Do it", body: `${PLAN_HEADING}\n\n1. step\n\n> Plan approved — parked for execution [now]\n` }))
  fs.mkdirSync(path.join(repo, "src"), { recursive: true })
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 1\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "seed: task plus source")
  return { repo, taskPath }
}

test("a loop's worktree carries the source but not the backlog", async () => {
  const { repo, taskPath } = await seedRepo()
  try {
    const isolated = await ensureIsolation(sh, noopLog, repo, config, entryState(taskPath))
    const wt = isolated.git?.worktree
    assert.ok(wt, "worktree mode must produce a worktree")

    assert.ok(fs.existsSync(path.join(wt, "src", "app.ts")), "the worktree must carry the source")
    assert.equal(fs.existsSync(path.join(wt, config.tasksDir)), false, "the worktree must NOT carry the backlog")

    // The main tree's backlog is untouched — it is the only live copy.
    assert.ok(fs.existsSync(taskPath), "the main tree keeps the real backlog")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("a checkpoint in the worktree neither stages nor deletes the sparse-excluded backlog", async () => {
  const { repo, taskPath } = await seedRepo()
  try {
    const isolated = await ensureIsolation(sh, noopLog, repo, config, entryState(taskPath))
    const wt = isolated.git!.worktree!

    fs.writeFileSync(path.join(wt, "src", "app.ts"), "export const a = 2\n")
    // Worktree mode excludes tasksDir from checkpoints as a second belt; the
    // sparse checkout means there is nothing there to stage either way.
    await commitAll(sh, wt, "checkpoint: iteration 1", [config.tasksDir])

    // The task file survives on the branch — a `git add -A` that treated the
    // absent sparse path as a deletion would drop it and resurrect the task in
    // the wrong status folder on merge.
    const tracked = await git(repo, "ls-tree", "-r", "--name-only", "feature/t1")
    assert.ok(tracked.includes(`${config.tasksDir}/in-progress/t1.md`), `backlog must stay tracked on the branch:\n${tracked}`)
    assert.ok(tracked.includes("src/app.ts"))

    // And the main tree's working copy is untouched by any of it.
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main")
    assert.ok(fs.existsSync(taskPath))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
