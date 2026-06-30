---
name: tasks
description: Reference for the filesystem task backlog that feeds the agentic loop. Use to understand the task file schema, the folder-as-status lifecycle (draft/approved/in-progress/completed/rejected), who moves files when, and how /loop next and /loop task <id> consume a task.
---

# The task backlog

Tasks are plain markdown files under `docs/tasks/`. **The folder a file lives in
is its status** — there is no `status:` field, so the two cannot drift.

```
docs/tasks/
  draft/        # WIP, not ready              ← you write here
  approved/     # ready to run                ← you move here (this is the gate)
  in-progress/  # the loop is running it      ← the driver moves here
  completed/    # verify passed               ← the driver moves here
  rejected/     # won't do                    ← you move here
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
  into `approved/` if it's ready).
- **`/task new <idea>`** — the `task-author` subagent turns a rough idea into a
  schema-valid file in `draft/` (deriving a kebab-case filename from the title and
  drafting testable acceptance criteria). Review it, then move it to `approved/`.

Either way the human moves the file to `approved/` — that move is the gate.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| `draft → approved` | **you** | the task is ready; this is the human gate |
| `approved → in-progress` | driver | `/loop next` / `/loop task <id>` picks it |
| `in-progress → completed` | driver | verify emits `LOOP_VERIFY: PASS` |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped |
| `→ rejected` | **you** | you decide not to do it |

A failed or stopped task is **left in `in-progress/`** with a note appended, so it
is visibly stuck for a human rather than silently re-queued. Move it back to
`approved/` yourself to retry, or to `rejected/` to abandon it.

## Running a task

- `/loop next` — lists `approved/`, picks the lowest `priority` (ties by id),
  starts the loop on it. Empty `approved/` → "No approved tasks" and nothing runs.
- `/loop task <id>` — runs a specific approved task by id.

From there the normal loop applies: explore → plan, then it pauses at the plan
gate for `/loop go`, then build → verify. See the `loop` skill for the stages,
the gate, the verify verdict contract, and termination.

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- The loop edits the current working tree; after a PASS, review the diff and open
  a PR yourself. There is no per-task branch/worktree.
- Promotion (`draft → approved`, `→ rejected`) is a manual file move — there is no
  approve command.
