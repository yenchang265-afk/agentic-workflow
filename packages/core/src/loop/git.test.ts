import assert from "node:assert/strict"
import { test } from "node:test"
import {
  addWorktree,
  branchExists,
  commitRemovals,
  deleteBranch,
  listWorktrees,
  pushBranch,
  removeWorktree,
  unmergedCommitCount,
  worktreeForBranch,
} from "./git.js"

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
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.deepEqual(added, { ok: true, error: "" })
  assert.ok(log.some((c) => c.includes("worktree add -b feature/add-foo /wt/add-foo main")))
})

test("addWorktree reuses an existing branch without -b (never resets it)", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("rev-parse --verify") ? { exitCode: 0 } : { exitCode: 0 }), log)
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.equal(added.ok, true)
  assert.ok(log.some((c) => c.includes("worktree add /wt/add-foo feature/add-foo")))
  assert.ok(!log.some((c) => c.includes("worktree add -b")))
})

// The reason a worktree add failed is the only actionable part of the error the
// caller throws — it used to be dropped, leaving "could not create worktree X" alone.
test("addWorktree surfaces git's stderr on failure", async () => {
  const $ = makeShell((cmd) =>
    cmd.includes("rev-parse --verify")
      ? { exitCode: 0 }
      : { exitCode: 128, stderr: "fatal: '/wt/add-foo' already exists\n" },
  )
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.deepEqual(added, { ok: false, error: "fatal: '/wt/add-foo' already exists" })
})

test("pushBranch pushes to origin with -u", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  const ok = await pushBranch($, "/repo", "feature/add-foo")
  assert.equal(ok, true)
  assert.ok(log.some((c) => c.includes("push -u origin feature/add-foo")))
})

test("pushBranch returns false when the push fails", async () => {
  const $ = makeShell(() => ({ exitCode: 1, stderr: "rejected" }))
  assert.equal(await pushBranch($, "/repo", "feature/add-foo"), false)
})

// --- delete-verb helpers ---

test("removeWorktree omits --force by default and adds it only when asked", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  assert.equal(await removeWorktree($, "/repo", "/wt/add-foo"), true)
  assert.ok(log.some((c) => c.includes("worktree remove /wt/add-foo")))
  assert.ok(!log.some((c) => c.includes("--force")), "the default must never force")

  log.length = 0
  assert.equal(await removeWorktree($, "/repo", "/wt/add-foo", { force: true }), true)
  assert.ok(log.some((c) => c.includes("worktree remove --force /wt/add-foo")))
  // Doubling -f would also remove LOCKED worktrees; a lock is a deliberate human act.
  assert.ok(!log.some((c) => c.includes("--force --force")), "single --force only")
})

test("removeWorktree reports failure (dirty or locked) rather than throwing", async () => {
  const $ = makeShell(() => ({ exitCode: 1, stderr: "contains modified files" }))
  assert.equal(await removeWorktree($, "/repo", "/wt/add-foo"), false)
})

test("deleteBranch uses -d by default and -D under force", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  assert.equal(await deleteBranch($, "/repo", "feature/add-foo"), true)
  assert.ok(log.some((c) => c.includes("branch -d feature/add-foo")))

  log.length = 0
  assert.equal(await deleteBranch($, "/repo", "feature/add-foo", { force: true }), true)
  assert.ok(log.some((c) => c.includes("branch -D feature/add-foo")))
})

test("deleteBranch returns false when git refuses (unmerged, or checked out)", async () => {
  const $ = makeShell(() => ({ exitCode: 1, stderr: "error: the branch is not fully merged" }))
  assert.equal(await deleteBranch($, "/repo", "feature/add-foo"), false)
})

/**
 * The exclude glob must be the BARE branch name: `--exclude` matches refs
 * without the `refs/heads/` prefix, so a fully-qualified ref matches nothing,
 * `--branches` re-includes the branch, it subtracts itself, and every branch
 * reports 0 unmerged — silently disarming the delete guard.
 */
test("unmergedCommitCount excludes the branch by bare name, keeps remotes in scope", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0, stdout: "3" }), log)
  assert.equal(await unmergedCommitCount($, "/repo", "feature/add-foo"), 3)
  const cmd = log.find((c) => c.includes("rev-list"))!
  assert.ok(cmd.includes("--exclude=feature/add-foo"), "bare name, not refs/heads/…")
  assert.ok(!cmd.includes("--exclude=refs/heads/"), "a qualified ref would match nothing")
  assert.ok(cmd.includes("--branches") && cmd.includes("--remotes"), "a pushed branch counts as safe")
})

test("unmergedCommitCount returns null when it cannot determine the answer", async () => {
  assert.equal(await unmergedCommitCount(makeShell(() => ({ exitCode: 1 })), "/repo", "nope"), null)
  assert.equal(await unmergedCommitCount(makeShell(() => ({ exitCode: 0, stdout: "" })), "/repo", "x"), null)
  assert.equal(await unmergedCommitCount(makeShell(() => ({ exitCode: 0, stdout: "garbage" })), "/repo", "x"), null)
})

/**
 * `commitRemovals` must NOT run `git add` first (it fails on a path whose file
 * is gone) and must name the files, not their directory (`git rm` prunes a
 * directory that just became empty).
 */
test("commitRemovals commits staged deletions by file path, with no add step", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  assert.equal(await commitRemovals($, "/repo", ["docs/tasks/draft/a.md"], "loop: deleted a"), true)
  assert.ok(!log.some((c) => c.includes(" add ")), "an add would fail on a deleted path")
  assert.ok(log.some((c) => c.includes("commit -m loop: deleted a -- docs/tasks/draft/a.md")))
})

test("commitRemovals is a no-op for an empty path list", async () => {
  const log: string[] = []
  assert.equal(await commitRemovals(makeShell(() => ({ exitCode: 0 }), log), "/repo", [], "m"), false)
  assert.deepEqual(log, [])
})
