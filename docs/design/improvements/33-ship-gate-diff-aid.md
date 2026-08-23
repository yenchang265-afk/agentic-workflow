English | [繁體中文](33-ship-gate-diff-aid.zh-TW.md)

# 33 — The ship gate leads with the diff it gates

**Status: implemented.**

## The problem

The ship gate's whole contract is "a human reviews the branch diff, then
approves" — and nothing anywhere computed that diff. The done note named a
branch and stopped; the OpenCode toast said "Review the diff on branch X" and
left the human to reconstruct the range by hand; the Claude host put the
errand in prose ("show the user the loop branch's diff summary"), i.e. asked
the MODEL to derive the one thing the gate is about; the hub's review queue
had no diff view at all. No `--stat`, `--shortstat`, or `--numstat` appeared
anywhere in product code. The human deciding whether a change is a two-line
fix or a forty-file rewrite had to go find out.

## What changed

- **`diffShortstat`** (`workflow/git.ts`): one `git diff --shortstat
  <base>...<branch>` by REF from the main checkout — works whether the branch
  sits in a worktree, on this tree, or checked out nowhere. The output is
  validated against the shortstat shape, not trusted: it lands on an audit
  line downstream parsers anchor on, so git chatter must read as "no stat".
- **`runDone` computes it while the run still knows its range** — the ship
  gate runs later from a fresh process — and threads it three ways:
  - the done note gains a trailing `; diff: 3 files changed, …` clause
    (`RUN_DIFF_PREFIX`). It goes LAST because its text carries commas and
    `runDoneField` terminates the branch/base values at the first comma after
    their prefixes — both earlier on the line, so they are unmoved
    (store.test pins that exact regression).
  - the `TerminalReport` done arm gains `diffstat` and `diffCmd` (the literal
    `git diff <base>...<branch>` to hand the human) — the OpenCode toast and
    the Claude `workflow_advance` ship-gate descriptor now lead with the
    numbers and the command instead of an errand.
  - **`extractRunDiffstat`** (`task/store.ts`) reads it back off the note —
    same last-marker + stamp rules as the refs beside it — and the hub's
    review queue (`ReviewItem.branch`/`diffstat`) shows "3 files changed, …
    on feature/x" on every in-review card, for free (the body was already in
    hand).

## Sharp edges

- Every failure degrades to exactly the pre-clause behavior: probe fails →
  no clause, old note byte-identical; note predates the clause → the hub and
  parser see `null`/`undefined`, never an error.
- The stat is display data, but it rides one line away from refs that reach
  `git push` — hence the strict shape check on BOTH ends (writer and parser),
  not just one.
- Current-branch mode works unchanged: the base is a sha, and
  `git diff <sha>...<branch>` is a legal range for both the stat and the
  handed-over command.
