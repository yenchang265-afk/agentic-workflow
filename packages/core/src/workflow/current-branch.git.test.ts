import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Log, Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import type { WorkflowState } from "./state.js"
import { commitAll } from "./git.js"
import { ensureIsolation, teardownIsolation } from "./isolate.js"

/**
 * Real-git regression for current-branch mode (`taskBranch: false`): the loop
 * must build on the branch the tree already has checked out, cutting nothing and
 * moving nothing.
 *
 * The fake-shell tests in isolate.test.ts pin the COMMANDS; only real git can
 * pin the two facts that matter to a human — the ref list does not grow, and
 * `git diff <base>...<branch>` actually shows this run's work when `base` is a
 * sha rather than a branch name. The teardown case is the sharpest: a sha `base`
 * reaching `checkoutBranch` creates a branch literally named after a commit and
 * leaves the human standing on it, which no assertion over a command log would
 * have caught as clearly as "no such ref exists".
 */

// A minimal bash-backed Shell — same harness as the other *.git.test.ts files
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
const config = { ...DEFAULT_CONFIG, taskBranch: false as const }

const entryState = (id = "t1"): WorkflowState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id, path: `docs/tasks/in-progress/${id}.md`, acceptance: [] },
})

const refCount = async (repo: string): Promise<number> =>
  (await git(repo, "for-each-ref", "--format=%(refname)", "refs/heads")).split("\n").filter(Boolean).length

/** A repo with one commit on `main`, then checked out onto `work`. */
const seedRepo = async (checkout = "work"): Promise<string> => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-workflow-current-branch-")))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Current Branch Test")
  fs.mkdirSync(path.join(repo, "docs", "tasks", "runs"), { recursive: true })
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "seed")
  if (checkout !== "main") await git(repo, "checkout", "-q", "-b", checkout)
  return repo
}

test("the loop builds on the checked-out branch: no ref is cut, no worktree, and the diff still works", async () => {
  const repo = await seedRepo()
  try {
    const before = await refCount(repo)
    const head = await git(repo, "rev-parse", "HEAD")

    const isolated = await ensureIsolation(sh, noopLog, repo, config, entryState())
    assert.deepEqual(isolated.git, { base: head, branch: "work", onCurrentBranch: true })
    assert.equal(isolated.isolated, true)
    assert.equal(isolated.git?.worktree, undefined)
    assert.equal(await refCount(repo), before, "the loop must not cut a branch")
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "work")
    assert.ok(!fs.existsSync(path.join(repo, ".workflow-worktrees")))

    // The whole reason `base` is a sha: with a branch-name base this diff would
    // be empty and REVIEW would grade nothing.
    fs.writeFileSync(path.join(repo, "built.txt"), "the loop's work\n")
    assert.equal(await commitAll(sh, repo, "loop(t1): checkpoint"), true)
    const diff = await git(repo, "diff", "--name-only", `${isolated.git!.base}...work`)
    assert.equal(diff, "built.txt")

    await teardownIsolation(sh, noopLog, repo, config, isolated)
    // No branch named after the commit, and the human is still where they were.
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "work")
    assert.equal(await refCount(repo), before, "teardown must not create a sha-named branch")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("starting on the default branch is refused, with nothing committed and nothing moved", async () => {
  const repo = await seedRepo("main")
  try {
    const commits = await git(repo, "rev-list", "--count", "HEAD")
    fs.writeFileSync(path.join(repo, "human-wip.txt"), "uncommitted work\n")

    await assert.rejects(() => ensureIsolation(sh, noopLog, repo, config, entryState()), /default branch/)

    // The refusal is the point: this mode's checkpoints are `git add -A` in the
    // human's own tree, so a run started here would commit onto main.
    assert.equal(await git(repo, "rev-list", "--count", "HEAD"), commits)
    assert.match(await git(repo, "status", "--porcelain"), /human-wip\.txt/)
    assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("a loser's teardown never releases the rival's lock — owner-aware release", async () => {
  const repo = await seedRepo()
  try {
    const first = await ensureIsolation(sh, noopLog, repo, config, entryState("t1"))
    // Simulate the sweep-and-retake: t2 now owns the lock (the marker t1 holds
    // went stale mid-run and a rival re-acquired it).
    const ownerFile = path.join(repo, ".git", "agentic-workflow", "current-branch", "owner.json")
    fs.writeFileSync(ownerFile, JSON.stringify({ id: "t2", branch: "work" }))

    // t1's drive ends (error path) — its teardown must NOT free t2's live lock:
    // a blind release here lets a third run in beside t2, the exact
    // two-runs-in-one-diff corruption the lock exists to prevent.
    await teardownIsolation(sh, noopLog, repo, config, first)
    assert.ok(fs.existsSync(ownerFile), "the rival's lock must survive the loser's teardown")
    await assert.rejects(() => ensureIsolation(sh, noopLog, repo, config, entryState("t3")), /t2/)

    // The rightful owner's teardown still releases.
    const second = { ...first, task: { ...first.task!, id: "t2" } }
    await teardownIsolation(sh, noopLog, repo, config, second)
    assert.ok(!fs.existsSync(ownerFile))
    const third = await ensureIsolation(sh, noopLog, repo, config, entryState("t3"))
    assert.equal(third.isolated, true)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("a second workflow on the same tree is refused while the first holds it", async () => {
  const repo = await seedRepo()
  try {
    const first = await ensureIsolation(sh, noopLog, repo, config, entryState("t1"))

    // Two runs here would commit inside each other's diff boundary — REVIEW
    // would grade work nobody planned, which is why the lock is cross-process.
    await assert.rejects(() => ensureIsolation(sh, noopLog, repo, config, entryState("t2")), /t1/)

    // The holder itself re-enters freely: every stage boundary and every
    // `recover` calls back in, and re-taking our own marker restamps it.
    const again = await ensureIsolation(sh, noopLog, repo, config, first)
    assert.equal(again.isolated, true)

    await teardownIsolation(sh, noopLog, repo, config, first)
    const second = await ensureIsolation(sh, noopLog, repo, config, entryState("t2"))
    assert.equal(second.isolated, true)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
