---
name: tasks
description: Reference for the filesystem task backlog that feeds the agentic loop. Use to understand the task file schema, the folder-as-status lifecycle (draft/in-progress/completed/abandoned), who moves files when, and how /loop next and /loop task <id> consume a task.
---

# The task backlog

Tasks are plain markdown files under `docs/tasks/`. **The folder a file lives in
is its status** — there is no `status:` field, so the two cannot drift.

```
docs/tasks/
  draft/        # WIP, not ready              ← you write here
  in-progress/  # ready to run / running it   ← you move here (this is the gate)
  completed/    # verify passed               ← the driver moves here
  abandoned/    # won't do                    ← you move here
```

## Task file schema

One file per task. YAML frontmatter + a free-form markdown body:

```md
---
title: Add rate limiting to the API     # required
priority: 2                             # optional; lower runs first (default 0)
acceptance:                             # optional; testable criteria → verify
  - Returns 429 over the limit
  - Limit is configurable per route
---
Throttle authenticated callers to 100 req/min. The body is the description /
context; it becomes the loop's goal, with `acceptance` threaded into the verify
stage so the verdict checks each criterion.
```

- **id** = the filename without `.md` (`add-foo.md` → `add-foo`). Stable, human-visible.
- **title** is required; everything else has a sane default.
- **acceptance** is optional but strongly recommended — it is what verify checks.

## Creating a task

- **By hand** — write a file matching the schema above into `draft/` (or straight
  into `in-progress/` if it's ready to run now).
- **`/task new <idea>`** — the `task-author` subagent turns a rough idea into a
  schema-valid file in `draft/` (deriving a kebab-case filename from the title and
  drafting testable acceptance criteria). Review it, then move it to `in-progress/`.

Either way the human moves the file to `in-progress/` — that move is the gate:
it's the decision to start planning and building it.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| `draft → in-progress` | **you** | the task is ready; this is the human gate |
| `in-progress → completed` | driver | verify emits `LOOP_VERIFY: PASS` |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped |
| `→ abandoned` | **you** | you decide not to do it |

A failed or stopped task is **left in `in-progress/`** with a note appended, so it
is visibly stuck for a human rather than silently re-queued. Run `/loop task <id>`
yourself to retry, or move it to `abandoned/` to give up on it.

The first time a task's plan gates for approval, it is also **persisted onto
the task file** under a `## Implementation Plan` heading — the on-disk marker
that the task is planned and awaiting a human. This survives a `/loop stop` or
an opencode restart, when the in-memory loop state does not.

### Identifying an interrupted loop

Loop state is in-memory only — a crash or restart mid-loop leaves no trace by
itself. What's on the task file tells you what happened:

- **A blockquote note** (`> ...`) — either a manual `/loop stop`/`/loop abort`,
  or an automatic verify-cap stop. Both are appended the same way.
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished` after
  it) — the only stage that edits files died mid-run, most likely a crash or a
  `/loop stop` issued while BUILD was active. Treat this as "check `git
  status`/`git diff` before doing anything else" — there may be a
  half-finished diff in the working tree. `/loop task <id>` surfaces this as a
  warning when resuming an already-planned task.
- **No markers at all, just `## Implementation Plan`** — safe: planned and
  waiting for approval, nothing has written code yet.

## Running a task

- `/loop next` — lists `in-progress/`, filters out tasks that already have a
  persisted plan, then picks the lowest `priority` among the rest (ties by id)
  and starts the loop on it. Empty `in-progress/` → "No tasks"; every task
  already planned → a message pointing you to `/loop task <id>` instead.
- `/loop task <id>` — runs a specific in-progress task by id. If it already has
  a persisted plan, this **resumes straight to the approval gate** with that
  plan (no re-planning) — the way to approve a plan after a stopped/restarted
  session. Otherwise it plans it fresh.

From there the normal loop applies: plan runs, then it pauses at the plan
gate for `/loop go`, then build → verify. See the `loop` skill for the stages,
the gate, the verify verdict contract, and termination.

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- The loop edits the current working tree; after a PASS, review the diff and open
  a PR yourself. There is no per-task branch/worktree.
- Promotion (`draft → in-progress`, `→ abandoned`) is a manual file move — there
  is no approve command.
