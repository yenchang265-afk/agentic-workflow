---
name: git-workflow-and-versioning
description: Structures history as save points — atomic commits, short-lived branches, reviewable diffs. Use when committing, branching, sizing a change, running parallel work streams in worktrees, or reporting what a change touched and deliberately left alone.
---

# Git Workflow and Versioning

A commit is a **save point**: the last state you can return to when the next
change goes wrong. Everything below follows from wanting that point to be close
behind you and to mean something when you land on it.

Agents generate code faster than anyone reviews it, so the discipline is not
ceremony — it is what keeps a run reversible.

## Commit each increment

```
Implement slice → test → verify → commit → next slice
```

Not: implement everything, hope, one giant commit. A save point you never made
cannot catch you, and a five-hour diff cannot be reviewed, bisected, or
reverted.

**One logical thing per commit.** `Add task creation endpoint with validation`
is a commit; `Add task feature, fix sidebar, update deps, refactor utils` is
four.

**Keep a formatting change in its own commit, separate from a behavior change,
and keep a refactor separate from a feature.** Mixed together, the behavior
change disappears inside the noise, and the refactor can no longer be reverted
on its own. Renaming one variable inside a feature commit is fine; anything a
reviewer would have to mentally subtract is not.

## Message shape

```
<type>: <short description>

<why, not what — the diff already carries the what>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

The body earns its place by stating intent the diff cannot:

```
feat: add email validation to registration endpoint

Prevents invalid formats reaching the database. Uses the Zod schema at the
route handler, consistent with auth.ts.
```

`update auth.ts` is a message that says nothing the diff didn't.

## Size the change

| Changed lines | Verdict |
|---|---|
| ~100 | Reviewable in one sitting |
| ~300 | Acceptable for a single logical change |
| ~1000 | Split it |

"One change" means one self-contained modification, with its tests, leaving the
system working — one part of a feature, not the whole feature. Complete file
deletions and mechanical automated refactors are the exception: the reviewer
verifies intent, not lines.

When it is too large, split by:

| Strategy | How | When |
|---|---|---|
| **Stack** | land a small change, base the next on it | sequential dependencies |
| **By file group** | separate changes per reviewer group | cross-cutting concerns |
| **Horizontal** | shared code and stubs first, consumers after | layered architecture |
| **Vertical** | smaller full-stack slices | feature work |

A diff that arrives oversized anyway is a review finding, not a blocker — see
`code-review-and-quality` → Severity.

## Branches are sandboxes, and they expire

Keep the default branch deployable and branch off it for a day or three, then
merge and delete. Every extra day a branch lives is divergence you will pay for
in conflicts at merge time; a feature flag defaulting off carries incomplete
work to the default branch far more cheaply than a long-lived branch does.
Release branches are the legitimate long-lived case.

```
feature/<short-description>   fix/<short-description>
chore/<short-description>     refactor/<short-description>
```

## Worktrees for parallel work

Several agents on one clone fight over the checked-out branch. A worktree gives
each its own directory and branch, so they never do:

```bash
git worktree add ../project-feature-a feature/task-creation
git worktree add ../project-feature-b feature/user-settings
git worktree remove ../project-feature-a   # when it has landed
```

A failed experiment is a directory you delete — nothing to unwind.

## Report the change, including what you left alone

After a modification, summarize what moved, what you deliberately did not
touch, and what you are unsure about:

```
CHANGED:
- src/routes/tasks.ts — validation middleware on POST
- src/lib/validation.ts — TaskCreateSchema

DELIBERATELY UNTOUCHED:
- src/routes/auth.ts — same validation gap, out of scope

CONCERNS:
- the schema rejects extra fields; confirm that is wanted
```

The untouched section is the load-bearing one: it proves scope discipline and
surfaces the adjacent problem without expanding the diff to cover it.

## Before each commit

Read `git diff --staged` and scan it for credentials before anything else — a
secret that reaches a remote is compromised and the fix is rotation, not a
follow-up commit. Then run tests, lint, and typecheck. A pre-commit hook makes
this automatic; running it by hand is the fallback, not the plan.

Keep build output (`dist/`, `.next/`), environment files, and local IDE config
out of the repository, and commit generated files only where the project
expects them (`package-lock.json`, migrations).

Bisecting to the commit that introduced a bug is triage, not workflow — the
recipe is `debugging-and-error-recovery` → Localize.

## Verification

- [ ] Each commit does one logical thing, with no formatting-only churn mixed in
- [ ] Each message states why, and uses one of the six types
- [ ] Tests, lint, and typecheck passed before the commit was made
- [ ] The staged diff was read and carries no credentials
- [ ] The change is under ~300 lines, or is split, or the oversize is reported
- [ ] The summary names what was deliberately left untouched
