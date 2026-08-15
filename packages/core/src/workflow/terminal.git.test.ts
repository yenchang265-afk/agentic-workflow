import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import type { Action, WorkflowState } from "./state.js"
import { commitAll, commitPaths } from "./git.js"
import { runTerminal, type TerminalCtx } from "./terminal.js"

/**
 * Real-git coverage of what `done` does to a shared tree. Two facts, and the
 * in-memory terminal tests can see neither (their fake shell has no branches),
 * so this drives `runTerminal` against an actual repository.
 *
 * 1. The tree is LEFT on `feature/<id>`. Teardown used to check it back out to
 *    base, which put the human one branch away from the work the "done" toast
 *    had just announced.
 * 2. The checkpoint still runs FIRST, so the backlog move is its own commit
 *    rather than being folded into the loop's `git add -A` checkpoint.
 *
 * Because (1) holds, the move now lands on the loop branch — the tree it is made
 * in — and the base branch is untouched by the run.
 */

// A minimal bash-backed Shell (the same surface plugins/claude/mcp-server/src/shim.ts
// implements; copied rather than imported — core tests must not reach into a plugin).
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

test("shared-tree done leaves the tree on the loop branch and lands the in-review move there", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-workflow-terminal-git-"))
  try {
    await git(repo, "init", "-q", "-b", "main")
    await git(repo, "config", "user.email", "test@example.com")
    await git(repo, "config", "user.name", "Terminal Test")

    // A claimed, plan-approved task committed in in-progress/ on main.
    const tasksDir = DEFAULT_CONFIG.tasksDir
    const taskDirAbs = path.join(repo, tasksDir, "in-progress")
    fs.mkdirSync(taskDirAbs, { recursive: true })
    const taskPath = path.join(taskDirAbs, "t1.md")
    fs.writeFileSync(taskPath, serializeTask({ title: "Do it", body: `${PLAN_HEADING}\n\n1. step\n\n> Plan approved — parked for execution [now]\n` }))
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "seed: task in in-progress")

    // Simulate established shared-tree isolation: the main tree sits on feature/t1
    // with build work committed there.
    await git(repo, "checkout", "-q", "-b", "feature/t1")
    fs.writeFileSync(path.join(repo, "built.txt"), "work\n")

    const state: WorkflowState = {
      goal: "Do it",
      stage: "review",
      iteration: 0,
      artifacts: {},
      task: { id: "t1", path: taskPath, acceptance: [] },
      git: { base: "main", branch: "feature/t1" },
      isolated: true,
    }
    const ctx: TerminalCtx = {
      $: sh,
      log: () => {},
      directory: repo,
      // ignoreBacklog defaults to true; this test asserts the backlog commit
      // strategy itself, so opt back into committing.
      config: { ...DEFAULT_CONFIG, ignoreBacklog: false },
      state,
      manifest: { manifest: { hooks: { validateBeforeTransition: {} } } } as unknown as LoadedManifest,
      actor: "tester",
      // The same strategies the hosts wire in: backlog commits via commitPaths on
      // the main tree, checkpoints via commitAll on the work tree (= main tree here).
      commitBacklog: async (m) => void (await commitPaths(sh, repo, [tasksDir], m)),
      checkpoint: async (m) => void (await commitAll(sh, repo, m)),
      writeMetrics: async () => {},
    }
    const done: Extract<Action, { kind: "done" }> = { kind: "done", message: "Loop complete — review passed." }
    const report = await runTerminal(ctx, done)
    assert.ok(report.kind === "done" && report.moved === true, `expected a moved done report, got ${JSON.stringify(report)}`)

    // Teardown left the tree where the work is, and the move is visible there.
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature/t1")
    assert.ok(fs.existsSync(path.join(repo, tasksDir, "in-review", "t1.md")), "task file must be in in-review/")
    assert.ok(!fs.existsSync(taskPath), "task file must have left in-progress/")

    // The loop branch carries the build work AND the move — as two commits, which
    // is what checkpointing before the backlog write buys.
    const onBranch = await git(repo, "ls-tree", "-r", "--name-only", "feature/t1")
    assert.ok(onBranch.includes("built.txt"), "the checkpoint must have committed the build work on the loop branch")
    assert.ok(onBranch.includes(`${tasksDir}/in-review/t1.md`), "the move must be committed on the loop branch")
    const subjects = await git(repo, "log", "--format=%s", "main..feature/t1")
    assert.equal(subjects.split("\n").filter(Boolean).length, 2, `checkpoint and backlog move must be separate commits: ${subjects}`)

    // The run never touched the base branch.
    const committedOnMain = await git(repo, "ls-tree", "-r", "--name-only", "main")
    assert.ok(!committedOnMain.includes(`${tasksDir}/in-review/t1.md`), "main must not carry the in-review move")
    assert.ok(!committedOnMain.includes("built.txt"), "main must not carry the build work")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
