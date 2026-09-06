English | [繁體中文](63-orphan-audit.zh-TW.md)

# 63 — The doctor audits the loop's leftovers: worktrees and branches

**Status: implemented.**

## The problem

The loop's leftovers accumulate by design: `teardownIsolation` keeps a
worktree so the next run resumes in it, and the ship gate releases only a
`completed/` task's. An abandoned, removed or hand-deleted task left its
`.workflow-worktrees/<id>` and `feature/<id>` forever. OpenCode's startup
reconcile named worktrees for in-progress/in-review tasks only and stopped
there; the Claude host had no equivalent; no host ever enumerated branches.
A repo that ran a hundred tasks carried a hundred branches and nothing said
so.

## What changed

- **`auditOrphans($, directory, config, kind, liveIds)`**
  (`workflow/orphans.ts`): worktrees under the configured root and branches
  under `taskBranchPrefix` whose id is not in `liveIds` (every non-terminal
  folder). Never the main tree, never a prunable registration, never a path
  outside the root. Each branch carries `merged` — `git merge-base
  --is-ancestor` against the default branch — so the report can say "safe
  to delete: `git branch -d`" or "NOT merged — keeps commits". Empty in
  current-branch mode, where there is no namespace.
- **`removeOrphanWorktrees`** is the one repair, through `releaseWorktreeAt`:
  never `--force` (a dirty one is kept and named), never a branch.
- **All three doctors** (`workflow_doctor`, the OpenCode verb, the hub's
  panel) report the section and remove the worktrees on fix; the hub's
  `DoctorReport` gains `orphans`/`orphanWorktrees`, the fix response
  `removedWorktrees`.
- **`listBranches`/`isAncestor`** in `workflow/git.ts` — `for-each-ref`, never
  `branch --list`'s decorated output.

## Sharp edges

- **A branch is never deleted by the doctor.** Unmerged commits are work,
  and even a merged branch is deleted by a human running the command the
  line names.
- **Live means any non-terminal folder.** A task parked at a gate keeps its
  worktree; only a task that has left the board is an orphan.
