import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { auditOrphans, formatOrphans, removeOrphanWorktrees } from "./orphans.js"

/** A fake shell answering the git commands the auditor issues. */
const makeShell = (handler: (cmd: string) => { exitCode?: number; stdout?: string } | undefined, log: string[] = []) =>
  ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += Array.isArray(exprs[i]) ? (exprs[i] as unknown[]).join(" ") : String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    log.push(norm)
    const out = handler(norm) ?? { exitCode: 1 }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: out.exitCode ?? 0, stdout: { toString: () => out.stdout ?? "" }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

const WORKTREES = [
  "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n",
  "worktree /repo/.workflow-worktrees/live1\nHEAD bbb\nbranch refs/heads/feature/live1\n",
  "worktree /repo/.workflow-worktrees/gone1\nHEAD ccc\nbranch refs/heads/feature/gone1\n",
  "worktree /repo/.workflow-worktrees/vanished\nHEAD ddd\nbranch refs/heads/feature/vanished\nprunable gitdir file points to non-existent location\n",
  "worktree /elsewhere/human\nHEAD eee\nbranch refs/heads/feature/human\n",
].join("\n")

const git = (cmd: string) => {
  if (cmd === "git -C /repo worktree list --porcelain") return { stdout: WORKTREES }
  if (cmd === "git -C /repo for-each-ref --format=%(refname:short) refs/heads/feature/") return { stdout: "feature/live1\nfeature/gone1\nfeature/merged1\nfeature/vanished\n" }
  if (cmd === "git -C /repo symbolic-ref refs/remotes/origin/HEAD") return { stdout: "refs/remotes/origin/main" }
  if (cmd.startsWith("git -C /repo merge-base --is-ancestor feature/merged1 ")) return { exitCode: 0 }
  if (cmd.startsWith("git -C /repo merge-base --is-ancestor ")) return { exitCode: 1 }
  return undefined
}

test("auditOrphans names worktrees and branches whose task left the board, never the main tree, a prunable entry, or a foreign path", async () => {
  const r = await auditOrphans(makeShell(git), "/repo", DEFAULT_CONFIG, "engineering", new Set(["live1"]))
  assert.deepEqual(r.worktrees, [{ path: "/repo/.workflow-worktrees/gone1", branch: "feature/live1".replace("live1", "gone1"), id: "gone1" }])
  assert.deepEqual(r.branches, [
    { branch: "feature/gone1", id: "gone1", merged: false },
    { branch: "feature/merged1", id: "merged1", merged: true },
    { branch: "feature/vanished", id: "vanished", merged: false },
  ])
  assert.equal(r.base, "main")
  const lines = formatOrphans(r)
  assert.match(lines[0]!, /orphan worktree \/repo\/\.workflow-worktrees\/gone1 \(feature\/gone1\) — no task gone1/)
  assert.match(lines.find((l) => l.includes("feature/merged1"))!, /safe to delete: git branch -d feature\/merged1/)
  assert.match(lines.find((l) => l.includes("feature/gone1 —"))!, /NOT merged — keeps commits/)
})

test("auditOrphans is empty in current-branch mode and when the default branch is unknown the merge state is null", async () => {
  assert.deepEqual(await auditOrphans(makeShell(git), "/repo", { ...DEFAULT_CONFIG, taskBranch: false }, "engineering", new Set()), { worktrees: [], branches: [], base: null })
  const noBase = (cmd: string) => (cmd.includes("symbolic-ref") || cmd.includes("init.defaultBranch") ? { exitCode: 1 } : git(cmd))
  const r = await auditOrphans(makeShell(noBase), "/repo", DEFAULT_CONFIG, "engineering", new Set(["live1"]))
  assert.equal(r.base, null)
  assert.ok(r.branches.every((b) => b.merged === null))
  assert.match(formatOrphans(r)[1]!, /merge state unknown/)
})

test("removeOrphanWorktrees removes through releaseWorktreeAt and reports only what actually left the list", async () => {
  const log: string[] = []
  let removed = false
  const shell = makeShell((cmd) => {
    if (cmd === "git -C /repo worktree list --porcelain") return { stdout: removed ? WORKTREES.replace(/worktree \/repo\/\.workflow-worktrees\/gone1[^]*?\n\n/, "") : WORKTREES }
    if (cmd === "git -C /repo/.workflow-worktrees/gone1 rev-parse --is-inside-work-tree") return { stdout: "true" }
    if (cmd === "git -C /repo worktree remove /repo/.workflow-worktrees/gone1") {
      removed = true
      return { exitCode: 0 }
    }
    if (cmd === "git -C /repo worktree prune") return { exitCode: 0 }
    return git(cmd)
  }, log)
  const report = await auditOrphans(shell, "/repo", DEFAULT_CONFIG, "engineering", new Set(["live1"]))
  const out = await removeOrphanWorktrees(shell, () => {}, "/repo", report)
  assert.deepEqual(out, ["/repo/.workflow-worktrees/gone1"])
  assert.ok(!log.some((c) => c.includes("branch -d") || c.includes("branch -D")), "a branch is never deleted")
  assert.ok(!log.some((c) => c.includes("--force")), "never --force")
})
