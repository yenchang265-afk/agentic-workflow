# Task backlog

Tasks the agentic loop runs. **The folder a task file lives in is its status** —
there is no `status:` field to keep in sync.

```
draft/        WIP, not ready              → you write here
approved/     ready to run                → you move here (the human gate)
in-progress/  the loop is running it      → the driver moves here
completed/    verify passed               → the driver moves here
rejected/     won't do                    → you move here
```

## Add a task

Either run **`/task new <idea>`** (a subagent drafts a schema-valid file into
`draft/` for you to review), or create the markdown file yourself in `draft/`
(or straight into `approved/` if it's ready):

```md
---
title: Add rate limiting to the API     # required
priority: 2                             # optional; lower runs first (default 0)
acceptance:                             # optional; testable criteria → verify
  - Returns 429 over the limit
  - Limit is configurable per route
---
Description / context. Becomes the loop's goal; `acceptance` is threaded into the
verify stage so the verdict checks each criterion.
```

The task **id** is the filename without `.md` (`add-foo.md` → `add-foo`).

## Run a task

- `/loop next` — picks the lowest-`priority` task in `approved/` (ties by id) and
  starts the loop on it.
- `/loop task <id>` — runs a specific approved task.

The driver moves the file `approved/ → in-progress/` on start and
`→ completed/` on a verify PASS. On failure or `/loop stop` it stays in
`in-progress/` with a note appended — move it back to `approved/` to retry or to
`rejected/` to abandon.

See `.opencode/skills/tasks/SKILL.md` for the full reference.
