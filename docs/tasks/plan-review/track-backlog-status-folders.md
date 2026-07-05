---
title: Track all backlog status folders in git
priority: 1
acceptance:
  - all seven status folders (draft, queued, plan-review, in-progress, in-review, completed, abandoned) exist under docs/tasks/ as tracked git paths (.gitkeep)
  - the task-backlog-management skill's folder checklist passes against a fresh clone
---
The repo ships the agentic-loop backlog tooling but has no docs/tasks/ tree of
its own — a fresh clone fails the task-backlog-management skill's verification
checklist ("all status folders exist, even if empty, via .gitkeep"), and
/explore or the loop would create folders ad hoc. Track the seven status
folders with .gitkeep files so the backlog root is present from clone time.

> Task approved — queued for planning [2026-07-05T13:13:18.955Z]

## Implementation Plan

**Problem** — the repo ships the backlog tooling but not the backlog tree:
`docs/tasks/` is absent from git, so a fresh clone fails the
`task-backlog-management` skill's verification checklist and the first
`/explore` or loop run creates folders ad hoc, untracked.

**Non-goals** — no `.gitkeep` for `docs/tasks/runs/` (its durable `*.md` logs
create it on demand and its `*.state.json`/`.stage.json` are gitignored); no
changes to `tasksDir` config handling or the folder-listing code (it already
tolerates absent folders).

**Assumptions** — default `tasksDir` (`docs/tasks`); empty status folders are
meaningful (folder = status) so `.gitkeep` placeholders are the right
mechanism, exactly as the skill's checklist prescribes.

**Steps**
1. Create `docs/tasks/{draft,queued,plan-review,in-progress,in-review,completed,abandoned}/.gitkeep`
   (seven empty files). `draft/` already exists on this branch from the task
   authoring — add its `.gitkeep` alongside.
2. No source changes.

**Acceptance criteria**
- `git ls-files 'docs/tasks/*/.gitkeep'` lists exactly the seven status folders.
- The `task-backlog-management` checklist item "all status folders exist
  (even if empty, via .gitkeep)" passes on a fresh clone.

**Reuse** — folder names must match `STATUSES` in `src/task/store.ts:74` and
`claude-plugin/mcp-server/src/lib/task/store.ts:71` (draft, queued,
plan-review, in-progress, in-review, completed, abandoned).

**Risks** — none material; empty `.gitkeep` files are inert. Only risk is a
name typo diverging from `STATUSES` — the acceptance check compares against
that list.

> Plan written — parked for plan review [2026-07-05T13:14:22.141Z]
