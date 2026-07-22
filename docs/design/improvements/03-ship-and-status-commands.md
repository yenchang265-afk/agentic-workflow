English | [繁體中文](03-ship-and-status-commands.zh-TW.md)

# 03 — `/agent-loop ship` and a real `/agent-loop status` dashboard

> **Addendum:** ship now also pushes the task's `feature/<id>` branch and
> opens (or reuses) a draft PR — GitHub or Azure DevOps per `codePlatform`.
> The audited-completion semantics below (human-invoked, note + commit,
> raw `mv` still works) are unchanged; PR creation is best-effort on top of
> them — a push/PR failure never blocks or rolls back the move. See
> `packages/core/src/loop/ship-pr.ts`.

## Context

Two ergonomic gaps in the daily workflow:

1. **`in-review → completed` is a raw `mv`.** The driver's done-toast
   (`driver.ts:372`) tells the human to move the file by hand. That move is
   the final gate decision — the one transition that means "a human reviewed
   the diff and shipped it" — yet it's the only lifecycle event with **no
   audit note and no commit**, on a branch of work whose whole point was a
   timestamped, attributed trail.
2. **`/agent-loop status` only reports the current session's loop**
   (`driver.ts:731-750`). There is no way to see the backlog's overall
   state — how many tasks are waiting where, which are stuck.

## Design

### `/agent-loop ship <id>` — audited completion

New branch in `handleCommand` (`src/loop/driver.ts`), alongside `recover`:

```
if (lower === "ship" || lower.startsWith("ship ")) {
  const id = arg.slice("ship".length).trim()
  if (!id) → toast "Usage: /agent-loop ship <id>."
  const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-review", id)
  if (!task) → toast `No in-review task "${id}".`
  await appendNote(deps.$, task, auditNote("Shipped — moved to completed", new Date(), await gitActor(...)))
  const newPath = await moveTask(deps.$, task, "completed")
  await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): shipped — completed`)
  → toast `"${task.title}" completed.` (success)
}
```

All four primitives exist (`findByIdIn`, `appendNote`+`auditNote`,
`moveTask`, `commitPaths`) — this is pure composition, ~20 lines.

Semantics: **the gate stays human.** `/agent-loop ship` is human-invoked; it
replaces an unaudited `mv` with an audited one. The raw `mv` keeps working
(folder-as-status is still the source of truth) — `ship` is the recommended
path, not a lock.

Update the done-toast (`driver.ts:372`) to say
`…then /agent-loop ship ${state.task.id} when it ships.` instead of describing the
manual move.

### `/agent-loop status` — backlog dashboard

Extend the existing `status` branch (`driver.ts:731`). Keep the current
session-loop line, then append a backlog summary:

- `listByStatus` (`store.ts:76`) over all six folders (one new call per
  folder; `listInPlanning`/`listInProgress` are thin wrappers over it
  already).
- Per folder: count, plus flags from existing pure predicates:
  - `in-planning`: how many `hasPlan` (gated, awaiting `/agent-loop go`) vs
    unplanned (waiting for `/agent-loop next`).
  - `in-progress`: how many `isClaimable` (parked, awaiting a watcher),
    `wasInterrupted` (crashed — list ids, suggest `/agent-loop recover`), and
    otherwise-started (live or stopped-with-note).
  - `in-review`: count + ids (each is an action item for a human — suggest
    `/agent-loop ship <id>`).
- Output: toasts are one-liners, so emit the summary via a single toast for
  the headline (`"backlog: 2 draft · 1 planning (1 gated) · 3 in-progress
  (1 interrupted) · 2 in-review"`) and `deps.log("info", …)` the detailed
  per-id breakdown. If toast length becomes limiting, the detail lives in
  the log only — don't fight the TUI.

Extract the aggregation into a pure helper for testability:

```ts
// src/task/store.ts (pure section)
export interface BacklogSummary { /* counts + id lists per flag */ }
export const summarizeBacklog = (byStatus: Record<TaskStatus, readonly Task[]>): BacklogSummary
```

Driver fetches, `summarizeBacklog` computes, driver formats.

## Edge cases

- `ship` on an id in some other folder → precise error ("in-progress, not
  in-review — the loop hasn't finished it" vs "not found anywhere").
  Implement by falling back to a `findById`-style probe across folders for
  the error message only.
- `ship` while a live loop drives the task: impossible by construction
  (a driven task is in `in-progress/`, `findByIdIn(..., "in-review")` misses
  it) — no extra guard needed.
- `commitPaths` failure (e.g. mid-rebase main tree): `moveTask` already
  happened — warn, don't roll back; the move is the source of truth, the
  commit is the record (same posture as every other best-effort commit in
  the driver).
- Empty backlog / missing folders: `listByStatus` already returns `[]` on
  absent folders.

## Test plan (TDD)

- `summarizeBacklog` (pure): counts, gated/unplanned split, interrupted
  ids, claimable counts — table-driven over synthetic `Task[]` fixtures
  (reuse the fixtures style of `src/task/store.test.ts`).
- `ship` command flow: extend the driver test harness — task in `in-review`
  ships (note appended, moved, committed); missing id errors; id in wrong
  folder errors with the folder named.
- Existing `status` tests (if any) keep passing; new assertion for the
  summary line.

## Docs to update

- `README.md` + `.opencode/commands/agent-loop.md` — add `ship <id>` and the
  richer `status` to the command list; replace "move the task to
  completed/" phrasing with `/agent-loop ship <id>`.
- `skills/workflow-orchestration/SKILL.md` — termination section: `/agent-loop ship`
  as the recommended final-gate action.
- `skills/task-backlog-management/SKILL.md` — lifecycle table
  `in-review → completed` row: "you, via `/agent-loop ship <id>` (or a manual
  move)"; Red Flags: a completed task with no "Shipped" note.
