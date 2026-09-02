English | [繁體中文](49-blocked-by.zh-TW.md)

# 49 — `blockedBy`: the one dependency gate the loop enforces

**Status: implemented.**

## The problem

A slice set's children were meant to be independent, but `new` allowed
stacked ones — a child that builds on a sibling's merged code — and the
only sequencing it could offer was `priority`, which ORDERS claims and does
not block them. `epic` is deliberately descriptive. So the human was the
dependency gate: approve and ship stacked children one at a time, in order,
and never let a `watch` worker see two of them build-ready at once — because
in worktree mode a watcher runs N drives concurrently, each cut from
`origin/main`, and the second child would be built against a base that does
not contain the first. Nothing on the task could say "not yet".

## What changed

- **`blockedBy: string[]` in `TaskFrontmatterSchema`** (default `[]`,
  omitted from the file when empty), carried through `Task`, `TaskInput`,
  `taskToInput` and `serializeTask` so the hub's in-place editor round-trips
  it. In the schema for the reason `epic` and `autoPlan` are: an off-schema
  key is deleted by the first rewrite.
- **A claim skips a blocked task.** `openBlockers(task, openIds)` keeps the
  ids still in a non-terminal folder (`ACTIVE_STATUSES`); `claimNext` drops
  such tasks from a pool's candidates BEFORE the predicate and the ordering,
  so no marker is taken on them and a lower-priority sibling behind them is
  claimed instead. The open-id set is listed LAZILY — only once some
  candidate declares a blocker — so a backlog that never uses the key pays no
  extra listings per tick.
- **`status` names what waits on what.** `summarizeBacklog` gains a
  `blocked` list (omitted when empty) and keeps blocked tasks out of
  `awaitingPlan`/`claimable`; `nextActions` renders one line per blocked task;
  a fully blocked walk's skip reason says which tasks wait on which ids.
- **The authoring prose sets it.** `new` step 3, the task-author agent's
  schema, and the backlog skill describe when to write it: only on a stacked
  slice, naming the sibling it builds on, never the epic.

## Sharp edges

- **A blocker unblocks by LEAVING the board** — completed, abandoned, or
  removed — not by reaching a status. A dangling id is a normal state (as
  for `epic`), so a dependency on work that will never land cannot wedge a
  task; `remove --force` and `abandon` both release dependents.
- **Claims only.** The human gates are untouched: a human may approve, plan,
  or ship a blocked task by hand, and `plan <id>` is not a claim walk. The
  gate this enforces is the UNATTENDED one.
- **A self-reference is ignored, not a deadlock**, and `openBlockers` never
  consults the body's prose.
