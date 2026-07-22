import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { ensureIsolation, releaseWorktree, teardownIsolation } from "./isolate.js"
import type { WorkflowState } from "./state.js"

/**
 * `ensureIsolation` shells out through the host `$`; the node+tsx runner can't
 * run Bun's `$`, so inject a fake that records each reconstructed command and
 * returns canned results — enough to cover base-branch selection (the bug-prone
 * bit). Real worktree creation is an e2e checklist item (see git.test.ts).
 *
 * The fake mirrors git.test.ts's harness. `git -C <cwd> …` puts the cwd in the
 * command string, so the two `is-inside-work-tree` probes (directory vs the new
 * worktree path) are told apart by which path they name.
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

const WT = "/repo/.wt/add-foo"
const noopLog = () => {}
const state: WorkflowState = {
  goal: "add foo",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id: "add-foo", path: "/repo/docs/tasks/in-progress/add-foo.md", acceptance: [] },
}
const config = { ...DEFAULT_CONFIG, worktreesDir: ".wt" }

/** Canned git for the fresh-worktree path. `headBranch` is what
 *  `rev-parse --abbrev-ref HEAD` reports for `directory` (the fallback base). */
const gitHandler = (headBranch: string) => (cmd: string): FakeResult => {
  if (cmd.includes("is-inside-work-tree")) return { exitCode: cmd.includes(WT) ? 1 : 0 } // dir=repo, wtPath=not yet
  if (cmd.includes("worktree list")) return { exitCode: 0, stdout: "" } // no existing worktree for the branch
  if (cmd.includes("rev-parse --verify")) return { exitCode: 1 } // branch absent → `-b`
  if (cmd.includes("path-format=absolute")) return { exitCode: 0, stdout: "/repo/.git" }
  if (cmd.includes("grep -qxF")) return { exitCode: 0 } // already excluded → skip append
  if (cmd.includes("status --porcelain")) return { exitCode: 0, stdout: "" } // clean
  if (cmd.includes("abbrev-ref HEAD")) return { exitCode: 0, stdout: headBranch }
  return { exitCode: 0 } // worktree add, etc.
}

test("baseBranch overrides directory's branch — worktree cut from it", async () => {
  const log: string[] = []
  const $ = makeShell(gitHandler("main"), log)
  const next = await ensureIsolation($, noopLog, "/repo", config, state, "feature-x")
  assert.equal(next.git?.base, "feature-x")
  assert.ok(log.some((c) => c.includes(`worktree add -b feature/add-foo ${WT} feature-x`)))
  // Override wins outright — the directory's current branch is never consulted.
  assert.ok(!log.some((c) => c.includes("abbrev-ref HEAD")))
})

test("without baseBranch, base falls back to directory's current branch", async () => {
  const log: string[] = []
  const $ = makeShell(gitHandler("dev"), log)
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.git?.base, "dev")
  assert.ok(log.some((c) => c.includes(`worktree add -b feature/add-foo ${WT} dev`)))
})

test("detached HEAD with no baseBranch → no isolation, no worktree created", async () => {
  const log: string[] = []
  // currentBranch returns null when abbrev-ref yields "HEAD".
  const $ = makeShell(gitHandler("HEAD"), log)
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.git, undefined)
  assert.ok(!log.some((c) => c.includes("worktree add")))
})

test("fresh engineering isolation marks the state isolated", async () => {
  const $ = makeShell(gitHandler("main"))
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.isolated, true)
  assert.equal(next.isolationWarning, undefined)
})

test("detached HEAD records an isolationWarning on the returned state", async () => {
  const $ = makeShell(gitHandler("HEAD"))
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.isolated, undefined)
  assert.match(next.isolationWarning ?? "", /detached HEAD/)
})

test("shared-tree checkout failure records an isolationWarning", async () => {
  const sharedConfig = { ...DEFAULT_CONFIG, worktreesDir: false as const }
  const $ = makeShell((cmd: string): FakeResult => {
    if (cmd.includes("abbrev-ref HEAD")) return { exitCode: 0, stdout: "main" }
    if (cmd.includes("status --porcelain")) return { exitCode: 0, stdout: "" }
    if (cmd.includes("rev-parse --verify")) return { exitCode: 1 } // branch absent
    if (cmd.includes("checkout")) return { exitCode: 1 } // checkout -b fails
    return { exitCode: 0 }
  })
  const next = await ensureIsolation($, noopLog, "/repo", sharedConfig, state)
  assert.equal(next.isolated, undefined)
  assert.match(next.isolationWarning ?? "", /could not check out feature\/add-foo/)
})

/**
 * A PR source (pr-sitter) pre-sets `git:{base,branch}` to name the PR's head to
 * isolate ONTO — with `isolated` still false. `ensureIsolation` must build a real
 * worktree for that EXISTING branch (never switch the human's main tree to it) and
 * mark the state isolated.
 */
const PR_WT = "/repo/.wt/pr-1"
const prState: WorkflowState = {
  kind: "pr-sitter",
  goal: "pr-1",
  stage: "fix",
  iteration: 0,
  artifacts: {},
  git: { base: "main", branch: "pr-head" },
}
const prGitHandler = (cmd: string): FakeResult => {
  if (cmd.includes("is-inside-work-tree")) return { exitCode: cmd.includes(PR_WT) ? 1 : 0 }
  if (cmd.includes("worktree list")) return { exitCode: 0, stdout: "" }
  if (cmd.includes("rev-parse --verify")) return { exitCode: 0 } // the PR head branch EXISTS (fetched)
  if (cmd.includes("grep -qxF")) return { exitCode: 0 }
  return { exitCode: 0 }
}

test("pre-set git (pr-sitter) builds a worktree on the existing head branch and marks isolated", async () => {
  const log: string[] = []
  const $ = makeShell(prGitHandler, log)
  const next = await ensureIsolation($, noopLog, "/repo", config, prState)
  assert.equal(next.git?.worktree, PR_WT)
  assert.equal(next.git?.branch, "pr-head")
  assert.equal(next.isolated, true)
  // Existing branch → checked out into the worktree with NO `-b` (never recreated).
  assert.ok(log.some((c) => c.includes(`worktree add ${PR_WT} pr-head`)), log.join(" | "))
  assert.ok(!log.some((c) => c.includes("worktree add -b")))
  // The main tree is NEVER switched to the PR branch.
  assert.ok(!log.some((c) => c.includes("checkout pr-head")))
})

test("pre-set git never adopts the MAIN tree as its worktree, even if it is on the branch", async () => {
  // `git worktree list` lists the main tree first; if the human left it on the PR
  // head branch, `worktreeForBranch` returns `/repo`. Adopting it would isolate onto
  // the human's tree — the reuse guard must skip it and create a real worktree instead.
  const log: string[] = []
  const mainOnBranch = (cmd: string): FakeResult => {
    if (cmd.includes("is-inside-work-tree")) return { exitCode: cmd.includes(PR_WT) ? 1 : 0 }
    if (cmd.includes("worktree list")) return { exitCode: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/pr-head\n" }
    if (cmd.includes("rev-parse --verify")) return { exitCode: 0 }
    if (cmd.includes("grep -qxF")) return { exitCode: 0 }
    return { exitCode: 0 }
  }
  const $ = makeShell(mainOnBranch, log)
  const next = await ensureIsolation($, noopLog, "/repo", config, prState)
  assert.equal(next.git?.worktree, PR_WT) // a separate worktree, NOT /repo
  assert.notEqual(next.git?.worktree, "/repo")
  assert.ok(log.some((c) => c.includes(`worktree add ${PR_WT} pr-head`)), log.join(" | "))
})

test("pre-set git already isolated (shared reconcile) does not rebuild a worktree", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("abbrev-ref HEAD") ? { exitCode: 0, stdout: "pr-head" } : { exitCode: 0 }), log)
  const sharedConfig = { ...config, worktreesDir: undefined }
  const next = await ensureIsolation($, noopLog, "/repo", sharedConfig, { ...prState, isolated: true })
  assert.equal(next.isolated, true)
  assert.ok(!log.some((c) => c.includes("worktree add")))
})

test("a failed worktree add throws with git's own reason attached", async () => {
  const failing = (cmd: string): FakeResult => {
    if (cmd.includes("worktree add")) return { exitCode: 128, stderr: `fatal: '${WT}' already exists` }
    return gitHandler("main")(cmd)
  }
  const $ = makeShell(failing)
  await assert.rejects(
    () => ensureIsolation($, noopLog, "/repo", config, state),
    (err: Error) => err.message.includes("already exists"),
  )
})

/**
 * A run ending is not the task ending. Teardown used to `worktree remove`, so the
 * next run (cap retry, `recover`, a `replan` bounce) had to re-add the worktree and
 * re-run `worktreeSetup` — slow on /mnt/c and intermittently fatal. The worktree now
 * survives until the ship gate calls `releaseWorktree`.
 */
test("teardown keeps the worktree so the next run resumes in it", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await teardownIsolation($, noopLog, "/repo", {
    ...state,
    git: { base: "main", branch: "feature/add-foo", worktree: WT },
    isolated: true,
  })
  assert.ok(!log.some((c) => c.includes("worktree remove")), log.join(" | "))
})

test("shared-tree teardown still returns the main tree to its base branch", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await teardownIsolation($, noopLog, "/repo", {
    ...state,
    git: { base: "main", branch: "feature/add-foo" },
    isolated: true,
  })
  assert.ok(log.some((c) => c.includes("checkout main")), log.join(" | "))
})

test("releaseWorktree removes the shipped task's worktree and prunes", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => {
    if (cmd.includes("worktree list")) return { exitCode: 0, stdout: `worktree ${WT}\nHEAD abc\nbranch refs/heads/feature/add-foo\n` }
    return { exitCode: 0 }
  }, log)
  await releaseWorktree($, noopLog, "/repo", config, "add-foo")
  assert.ok(log.some((c) => c.includes(`worktree remove ${WT}`)), log.join(" | "))
  assert.ok(log.some((c) => c.includes("worktree prune")))
})

test("releaseWorktree never removes the main tree, even when it sits on the branch", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => {
    if (cmd.includes("worktree list")) return { exitCode: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/feature/add-foo\n" }
    // The computed fallback path holds no worktree — nothing to remove.
    if (cmd.includes("is-inside-work-tree")) return { exitCode: 1 }
    return { exitCode: 0 }
  }, log)
  await releaseWorktree($, noopLog, "/repo", config, "add-foo")
  assert.ok(!log.some((c) => c.includes("worktree remove")), log.join(" | "))
})

test("releaseWorktree is a no-op in shared-tree mode", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await releaseWorktree($, noopLog, "/repo", { ...config, worktreesDir: false }, "add-foo")
  assert.equal(log.length, 0)
})

test("releaseWorktree leaves a dirty worktree in place rather than forcing it", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => {
    if (cmd.includes("worktree list")) return { exitCode: 0, stdout: `worktree ${WT}\nHEAD abc\nbranch refs/heads/feature/add-foo\n` }
    if (cmd.includes("worktree remove")) return { exitCode: 1, stderr: "fatal: contains modified or untracked files" }
    return { exitCode: 0 }
  }, log)
  await releaseWorktree($, noopLog, "/repo", config, "add-foo")
  assert.ok(!log.some((c) => c.includes("--force")), log.join(" | "))
})
