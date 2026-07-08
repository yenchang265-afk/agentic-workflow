import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { ensureIsolation } from "./isolate.js"
import type { LoopState } from "./state.js"

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
const state: LoopState = {
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
  assert.ok(log.some((c) => c.includes(`worktree add -b loop/add-foo ${WT} feature-x`)))
  // Override wins outright — the directory's current branch is never consulted.
  assert.ok(!log.some((c) => c.includes("abbrev-ref HEAD")))
})

test("without baseBranch, base falls back to directory's current branch", async () => {
  const log: string[] = []
  const $ = makeShell(gitHandler("dev"), log)
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.git?.base, "dev")
  assert.ok(log.some((c) => c.includes(`worktree add -b loop/add-foo ${WT} dev`)))
})

test("detached HEAD with no baseBranch → no isolation, no worktree created", async () => {
  const log: string[] = []
  // currentBranch returns null when abbrev-ref yields "HEAD".
  const $ = makeShell(gitHandler("HEAD"), log)
  const next = await ensureIsolation($, noopLog, "/repo", config, state)
  assert.equal(next.git, undefined)
  assert.ok(!log.some((c) => c.includes("worktree add")))
})
