import assert from "node:assert/strict"
import { test } from "node:test"
import { addWorktree, branchExists, listWorktrees, worktreeForBranch } from "./git.js"

/**
 * git.ts shells out via Bun's `$` (redirections, quoting) which the node+tsx
 * test runner can't execute. These tests inject a fake `$` that records the
 * reconstructed command and returns canned output — enough to cover the arg
 * construction and porcelain parsing (the bug-prone logic). Real end-to-end
 * worktree creation is a manual/e2e checklist item (see docs/design/improvements/01).
 */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }

const makeShell = (handler: (cmd: string) => FakeResult, log?: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log?.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const PORCELAIN = [
  "worktree /repo",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /repo/.loop-worktrees/add-foo",
  "HEAD def456",
  "branch refs/heads/feature/add-foo",
  "",
  "worktree /repo/detached",
  "HEAD 999aaa",
  "detached",
  "",
].join("\n")

test("branchExists maps a zero exit code to true", async () => {
  const yes = makeShell(() => ({ exitCode: 0 }))
  const no = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await branchExists(yes, "/repo", "feature/x"), true)
  assert.equal(await branchExists(no, "/repo", "feature/x"), false)
})

test("listWorktrees parses porcelain stanzas, including a detached entry", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN }))
  const entries = await listWorktrees($, "/repo")
  assert.deepEqual(entries, [
    { path: "/repo", branch: "main" },
    { path: "/repo/.loop-worktrees/add-foo", branch: "feature/add-foo" },
    { path: "/repo/detached", branch: null },
  ])
})

test("listWorktrees returns [] when the command fails", async () => {
  const $ = makeShell(() => ({ exitCode: 128, stderr: "not a git repo" }))
  assert.deepEqual(await listWorktrees($, "/nope"), [])
})

test("worktreeForBranch finds the matching worktree path", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN }))
  assert.equal(await worktreeForBranch($, "/repo", "feature/add-foo"), "/repo/.loop-worktrees/add-foo")
  assert.equal(await worktreeForBranch($, "/repo", "feature/missing"), null)
})

test("addWorktree creates a new branch with -b when the branch is absent", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("rev-parse --verify") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const ok = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.equal(ok, true)
  assert.ok(log.some((c) => c.includes("worktree add -b feature/add-foo /wt/add-foo main")))
})

test("addWorktree reuses an existing branch without -b (never resets it)", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("rev-parse --verify") ? { exitCode: 0 } : { exitCode: 0 }), log)
  const ok = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.equal(ok, true)
  assert.ok(log.some((c) => c.includes("worktree add /wt/add-foo feature/add-foo")))
  assert.ok(!log.some((c) => c.includes("worktree add -b")))
})
