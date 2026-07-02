# Task backlog

Tasks the agentic loop runs. **The folder a task file lives in is its status** —
there is no `status:` field to keep in sync.

```
draft/        WIP, not ready                → you write here
in-planning/  queued for / undergoing plan  → you move here (gate 1)
in-progress/  build → verify → review → ship → the driver moves here (on plan approval)
completed/    loop finished (shipped)       → the driver moves here
abandoned/    won't do                      → you move here, from any status
```

## Add a task

Two ways:

- **`/task new <idea>`** — a subagent drafts a schema-valid file into `draft/`
  for you to review. It also asks whether an Azure DevOps work item covers
  this task — linking an existing one (asking for its project name *and*
  work item id) or offering to create one (asking for a project *and* a
  repo, always with your confirmation before creating anything) —skipping
  that step gracefully if no Azure DevOps MCP server is connected. Either
  way, it shows you the drafted task and asks if it looks right before
  writing anything. See
  [`skills/task-backlog-management/SKILL.md`](../../skills/task-backlog-management/SKILL.md#linking-a-task-to-azure-devops).
- **Create the markdown file yourself** in `draft/`:

```md
---
title: Add rate limiting to the API     # required
priority: 2                             # optional; lower runs first (default 0)
acceptance:                             # optional; testable criteria → verify
  - Returns 429 over the limit
  - Limit is configurable per route
azureId: '1234'                         # optional; linked Azure DevOps work item
azureProject: Platform                  # optional; only alongside azureId
azureRepo: platform-api                 # optional; only alongside azureId
azureUrl: https://dev.azure.com/...     # optional; only alongside azureId
---
Description / context. Becomes the loop's goal; `acceptance` is threaded into the
verify stage so the verdict checks each criterion.
```

The task **id** is the filename without `.md` (`add-foo.md` → `add-foo`).

New tasks always land in `draft/` — you decide what's worth planning by
moving it to `in-planning/` yourself; that's the first human gate.

## Run a task

- `/loop next` — picks the lowest-`priority` task in `in-planning/` that
  **doesn't already have a plan** (ties by id) and starts the loop on it
  (DEFINE→PLAN).
- `/loop task <id>` — runs a specific in-planning task. If it already has a
  plan on file, this resumes straight to the approval gate instead of
  re-planning.

The task stays in `in-planning/` through DEFINE and PLAN, including while a
generated plan waits for your review — check `/loop status` or the toast
message to see it's waiting; there's no separate folder for that. The first
time its plan gates for approval, the plan is appended to the task file
under `## Implementation Plan`, so `/loop next` skips it next time and
`/loop task <id>` can pick the approval back up later.

**`/loop go`** at the plan gate is the second gate, and the only automatic
folder move: the driver moves the file `in-planning/ → in-progress/` itself
— that approval already is the decision to start writing code, the move just
records it — then runs BUILD→VERIFY→REVIEW→SHIP. The driver moves the file
`in-progress/ → completed/` when the loop finishes. On failure or `/loop
stop` while building, it stays in `in-progress/` with a note appended — run
`/loop task <id>` again to retry (see the recovery note below), or move it
to `abandoned/` to give up on it.

Loop state is in-memory only, so a crash mid-`BUILD` (the only stage that
edits files) leaves no trace by itself — the driver brackets each build with
`> BUILD started`/`> BUILD finished` notes, so an unmatched `started` means a
build may have died mid-run. `/loop task <id>` warns you about this before you
approve, so check `git status`/`git diff` first.

**Recovery note:** `/loop task <id>` only looks in `in-planning/`. If a
session dies while a task is already in `in-progress/` (mid-build or later),
that command won't find it — move the file back to `in-planning/` by hand
and run `/loop task <id>` again to re-plan and restart it cleanly.

See [`skills/task-backlog-management/SKILL.md`](../../skills/task-backlog-management/SKILL.md) for the full reference.
