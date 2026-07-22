import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Client, Log, Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import type { Action, LoopState } from "./state.js"
import { commitAll, commitPaths } from "./git.js"
import { shipTask, type GateCtx } from "./gate.js"
import { ensureIsolation } from "./isolate.js"
import { runTerminal, type TerminalCtx } from "./terminal.js"

/**
 * Real-git regression for the worktree lifecycle: a task's worktree must survive
 * the end of a run and be removed only when the task ships.
 *
 * The bug: every terminal path tore the worktree down, so the next run had to
 * re-`worktree add` and re-run `worktreeSetup`. On /mnt/c that round-trip is slow
 * and intermittently fails outright — "could not recreate worktree …" killed the
 * loop instead of resuming it. The in-memory isolate tests can't see the
 * end-to-end sequence (their fake shell has no real worktrees), so this one
 * drives the actual git commands.
 */

// A minimal bash-backed Shell — same harness as terminal.git.test.ts (copied
// rather than imported; core tests must not reach into a plugin's shim).
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
const wtOf = (repo: string): string => path.join(repo, ".workflow-worktrees", "t1")

/** The entry state a fresh claim builds — no `git`, exactly like source/backlog.ts. */
const entryState = (taskPath: string): LoopState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id: "t1", path: taskPath, acceptance: [] },
})

const seedRepo = async (): Promise<{ repo: string; taskPath: string }> => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-workflow-worktree-")))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Worktree Test")
  const taskDirAbs = path.join(repo, config.tasksDir, "in-progress")
  fs.mkdirSync(taskDirAbs, { recursive: true })
  const taskPath = path.join(taskDirAbs, "t1.md")
  fs.writeFileSync(taskPath, serializeTask({ title: "Do it", body: `${PLAN_HEADING}\n\n1. step\n\n> Plan approved — parked for execution [now]\n` }))
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "seed: task in in-progress")
  return { repo, taskPath }
}

const terminalCtx = (repo: string, state: LoopState): TerminalCtx => ({
  $: sh,
  log: noopLog,
  directory: repo,
  config,
  state,
  manifest: { manifest: { hooks: { validateBeforeTransition: {} } } } as unknown as LoadedManifest,
  actor: "tester",
  commitBacklog: async (m) => void (await commitPaths(sh, repo, [config.tasksDir], m)),
  // In worktree mode the checkpoint commits the WORKTREE, not the main tree.
  checkpoint: async (m) => void (await commitAll(sh, state.git?.worktree ?? repo, m)),
  writeMetrics: async () => {},
})

test("a stopped run keeps its worktree and the next run resumes in it", async () => {
  const { repo, taskPath } = await seedRepo()
  try {
    // --- run 1: isolate, do work, stop short of done (e.g. the iteration cap).
    const isolated = await ensureIsolation(sh, noopLog, repo, config, entryState(taskPath))
    const wt = wtOf(repo)
    assert.equal(isolated.git?.worktree, wt)
    assert.equal(isolated.git?.branch, "feature/t1")
    fs.writeFileSync(path.join(wt, "iteration-1.txt"), "first pass\n")

    const stop: Extract<Action, { kind: "stop" }> = { kind: "stop", message: "iteration cap reached" }
    const report = await runTerminal(terminalCtx(repo, isolated), stop)
    assert.equal(report.kind, "stop")

    // The worktree SURVIVES the run, with the first pass committed on the branch.
    assert.ok(fs.existsSync(wt), "worktree must outlive the run")
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the main tree is untouched")
    assert.ok((await git(repo, "ls-tree", "-r", "--name-only", "feature/t1")).includes("iteration-1.txt"))

    // --- run 2: a fresh claim (no state.git) must ADOPT the same worktree.
    const before = (await git(repo, "worktree", "list")).split("\n").length
    const again = await ensureIsolation(sh, noopLog, repo, config, entryState(taskPath))
    assert.equal(again.git?.worktree, wt, "the second run reuses the same directory")
    assert.equal((await git(repo, "worktree", "list")).split("\n").length, before, "no second worktree was added")
    // The previous iteration's work is present to build on — the whole point.
    assert.ok(fs.existsSync(path.join(wt, "iteration-1.txt")), "iteration 2 starts on top of iteration 1")

    // --- ship: the task is finished, so the worktree is finally released.
    fs.mkdirSync(path.join(repo, config.tasksDir, "in-review"), { recursive: true })
    await git(repo, "mv", `${config.tasksDir}/in-progress/t1.md`, `${config.tasksDir}/in-review/t1.md`)
    await git(repo, "commit", "-q", "-m", "park in in-review")
    const gateCtx: GateCtx = {
      $: sh,
      client: { file: { list: async () => ({ data: [] }), read: async () => ({ data: null }) }, app: { log: async () => undefined } } as unknown as Client,
      log: noopLog,
      directory: repo,
      config,
      isDriving: () => false,
    }
    const shipped = await shipTask(gateCtx, "t1")
    assert.ok(shipped.ok, `ship failed: ${shipped.message}`)
    assert.ok(!fs.existsSync(wt), "ship removes the worktree")
    // The branch — and therefore the PR and the human's diff — is untouched.
    assert.ok((await git(repo, "ls-tree", "-r", "--name-only", "feature/t1")).includes("iteration-1.txt"))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("re-shipping a completed task releases the worktree a mid-ship crash left behind", async () => {
  const { repo, taskPath } = await seedRepo()
  try {
    const isolated = await ensureIsolation(sh, noopLog, repo, config, entryState(taskPath))
    const wt = wtOf(repo)
    assert.equal(isolated.git?.worktree, wt)
    // Simulate the crash window inside shipTask: the task already moved + committed
    // to completed/, but the process died before releaseWorktree ran.
    fs.mkdirSync(path.join(repo, config.tasksDir, "completed"), { recursive: true })
    await git(repo, "mv", `${config.tasksDir}/in-progress/t1.md`, `${config.tasksDir}/completed/t1.md`)
    await git(repo, "commit", "-q", "-m", "crashed mid-ship")
    const gateCtx: GateCtx = {
      $: sh,
      client: { file: { list: async () => ({ data: [] }), read: async () => ({ data: null }) }, app: { log: async () => undefined } } as unknown as Client,
      log: noopLog,
      directory: repo,
      config,
      isDriving: () => false,
    }
    const retried = await shipTask(gateCtx, "t1")
    assert.ok(retried.ok, `retry failed: ${retried.message}`)
    assert.equal(retried.data?.alreadyDone, true)
    assert.ok(!fs.existsSync(wt), "the ship retry releases the orphaned worktree")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

/** A free-text (task-less) loop's entry state — no `task`, so no ship gate ever runs for it. */
const freeState = (): LoopState => ({
  goal: "Free-text goal",
  stage: "build",
  iteration: 0,
  artifacts: {},
})

test("a task-less loop keeps its worktree on stop but releases it on done — no ship gate ever will", async () => {
  const { repo } = await seedRepo()
  try {
    // --- stop: a recover may resume this loop, so the worktree survives.
    let state = await ensureIsolation(sh, noopLog, repo, config, freeState())
    const wt = path.join(repo, ".workflow-worktrees", "free-text-goal")
    assert.equal(state.git?.worktree, wt)
    fs.writeFileSync(path.join(wt, "work.txt"), "wip\n")
    let report = await runTerminal(terminalCtx(repo, state), { kind: "stop", message: "capped" })
    assert.equal(report.kind, "stop")
    assert.ok(fs.existsSync(wt), "stop keeps the worktree for recover")

    // --- done: nothing will ever release it later, so done reclaims it now.
    state = await ensureIsolation(sh, noopLog, repo, config, freeState())
    report = await runTerminal(terminalCtx(repo, state), { kind: "done", message: "finished" })
    assert.equal(report.kind, "done")
    assert.ok(!fs.existsSync(wt), "done releases a task-less loop's worktree")
    // The checkpointed work survives on the branch.
    assert.ok((await git(repo, "ls-tree", "-r", "--name-only", "feature/free-text-goal")).includes("work.txt"))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
