# Task backlog

Tasks the agentic loop runs. **The folder a task file lives in is its status** —
there is no `status:` field to keep in sync.

```
draft/        WIP, not ready              → you write here
in-progress/  ready to run / running it   → you move here (the human gate)
completed/    verify passed               → the driver moves here
abandoned/    won't do                    → you move here
```

## Add a task

Either run **`/task new <idea>`** (a subagent drafts a schema-valid file into
`draft/` for you to review), or create the markdown file yourself in `draft/`
(or straight into `in-progress/` if it's ready):

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

- `/loop next` — picks the lowest-`priority` task in `in-progress/` that
  **doesn't already have a plan** (ties by id) and starts the loop on it.
- `/loop task <id>` — runs a specific in-progress task. If it already has a
  plan on file, this resumes straight to the approval gate instead of
  re-planning.

Moving a task to `in-progress/` is the human gate — it starts the loop. The
first time its plan gates for approval, the plan is appended to the task file
under `## Implementation Plan`, so `/loop next` skips it next time and
`/loop task <id>` can pick the approval back up later. The driver moves the
file `in-progress/ → completed/` on a verify PASS. On failure or `/loop stop`
it stays in `in-progress/` with a note appended — run `/loop task <id>` again
yourself to retry, or move it to `abandoned/` to give up on it.

Loop state is in-memory only, so a crash mid-`BUILD` (the only stage that
edits files) leaves no trace by itself — the driver brackets each build with
`> BUILD started`/`> BUILD finished` notes, so an unmatched `started` means a
build may have died mid-run. `/loop task <id>` warns you about this before you
approve, so check `git status`/`git diff` first.

See `.opencode/skills/tasks/SKILL.md` for the full reference.
