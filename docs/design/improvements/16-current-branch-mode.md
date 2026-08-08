English | [繁體中文](16-current-branch-mode.zh-TW.md)

# 16 — Building on the checked-out branch (`taskBranch`)

**Status: implemented.** The `taskBranch` config key and the `taskBranchFor` /
`taskBranchPrefix` / `worktreesDirFor` accessors in `packages/core/src/config.ts`;
`GitRef.onCurrentBranch` in `workflow/state.ts` (mirrored in `workflow/persist.ts`);
`headSha` / `defaultBranchName` / `gitCommonDir` in `workflow/git.ts`; the
current-branch arms of `ensureIsolation` and `teardownIsolation`, plus
`assertNotDefaultBranch` and the one-run-per-tree lock, in `workflow/isolate.ts`;
`extractRunBranch` in `task/store.ts` and the branch it is read from in
`workflow/terminal.ts`; the branch resolution and PR-base fix in
`workflow/ship-pr.ts`; `git.cut` / `git.current` in `workflow/engine.ts` and the
three engineering stage templates. Tests: `current-branch.git.test.ts`,
`isolate.test.ts`, `git.test.ts`, `config.test.ts`, `store.test.ts`,
`ship-pr.test.ts`.

## Context

`ensureIsolation` had two modes and both took the work somewhere else: a
`git worktree` on `feature/<id>` (the default), or a `git checkout -b feature/<id>`
in the main tree (`worktreesDir: false`). The branch name itself was hard-coded
in three places.

That is right for unattended work, and wrong for the case it left no room for:
a human already sitting on the branch this work belongs on — mid-PR, on a review
branch, on a spike. For them the loop stranded its output on a second branch and
`teardownIsolation` then checked them back off it, so the work they asked for was
somewhere they were not.

`worktreesDir: false` looked like the escape hatch and is not: it only removes
the worktree, still cutting and checking out `feature/<id>`.

## The one non-obvious consequence

The loop measures its own work as `git diff <base>...<branch>` — that boundary is
what stops REVIEW grading pre-existing code. When the loop cuts a branch, `base`
is the branch it was cut from. When it does *not*, base and branch name the same
ref and the diff is **empty**: REVIEW would see nothing and pass.

So in this mode `base` is HEAD's **sha** at the first BUILD — an ancestor of every
checkpoint that follows, so the three-dot form equals a plain two-dot diff. That
makes `base` polymorphic, which two call sites could not tolerate:

- `teardownIsolation` ran `checkoutBranch(base)`. `checkoutBranch` falls through
  to `git checkout -b <ref>` when the ref is not a branch, so this would have
  created a branch literally named after a commit and left the human on it.
- `shipGithub`/`shipAdo` fell back to `currentBranch(directory)` for the PR base.
  Teardown now deliberately leaves the tree on the shipped branch, so that
  fallback asked for a PR from a branch onto itself.

`GitRef.onCurrentBranch` is the discriminant for both, and for the prompt (a
template must not call a sha a branch). It has to be mirrored in
`persist.ts`'s `GitRefSchema`, because zod strips unknown keys — a
snapshot-resumed run would otherwise lose the flag and hit the first bug above.

## What the mode guarantees

- **Worktrees are forced off** (`worktreesDirFor`), because git will not check
  one branch out twice. Forced rather than rejected in the schema: `worktreesDir`
  has a truthy default, so a `superRefine` would fail a user who wrote only
  `taskBranch: false` and blame a key they never set. The drop is logged once.
- **It refuses to start on the default branch.** The checkpoints here are
  `git add -A && git commit` in the human's own tree; started from `main` they
  would commit onto it. Detection is local (`origin/HEAD`, then
  `init.defaultBranch`, then the conventional names) — never `gh repo view`,
  which would put a network round trip in front of every fresh BUILD.
- **One run per working tree, across processes.** The OpenCode driver's
  `executingDirs` set is per plugin instance. In shared-tree mode a collision
  costs a branch switch; here it costs a wrong verdict, because a second run's
  commits land inside the first's diff boundary. A mkdir marker with the claim
  markers' staleness contract covers the rest.

The marker lives under `<git-common-dir>`, not beside the state snapshots in the
backlog. This is the one mode whose checkpoints `git add -A` the human's own
checkout, and in the backlog the marker rode straight into their feature commits
— caught by `current-branch.git.test.ts`, not by any fake-shell assertion.

## Shipping

`shipPr` receives only a task id, and the state snapshot is already gone by then
(`clearState` fires in `runDone`, while `shipTask` runs later, from a fresh
process). So the branch is recorded on the **task file** — `runDone`'s audit note
names it and `extractRunBranch` reads it back, requiring the audit stamp so a
plan merely quoting the line cannot inject a branch name into `git push`.

That also fixes a latent bug in the branch-cutting modes: a `taskBranch` prefix
changed between the run and the ship would previously have pushed the wrong
branch.

## Scope

Only the `engineering` kind honors the key. `pr-sitter` and `main-sitter`
**pre-set** `state.git` from their work source — a PR's own head branch, a remedy
branch named after the red commit — which the loop does not choose and cannot
override. `dep-sitter`'s publish stage pins the literal `git push origin feature/*`
in its bash allowlist, and those manifests ship read-only inside the core package,
so any other prefix would make its own guard deny its push.

## Migration

None. `taskBranch` defaults to `"feature/"`, which reproduces the old hard-coded
name exactly.
