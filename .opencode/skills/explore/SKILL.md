---
name: explore
description: Reference for the standalone repo-improvement scanner. Use to understand when to run /explore, what it looks for, how it dedupes and caps findings, and how it differs from /task new. Not part of the /loop pipeline.
---

# Repo improvement scan

`/explore` is a **standalone** command — independent of `/loop`. It scans the
repo for improvements nobody has asked for yet (refactors, dead code,
duplicated logic, tech debt, stale docs) and files each one as a draft
backlog task for a human to review.

## When to run it

- Periodically, or whenever the repo feels due for a cleanup pass.
- Scoped to an area: `/explore src/loop` focuses the scan on a path.
- **Not** as part of an active `/loop` run — it has no relationship to a
  specific goal; `/loop` starts at `PLAN` directly (see the `loop` skill).

## Output

- Up to **5** new task files per run, written to `docs/tasks/draft/`, each
  matching the task schema (`title`/`priority`/`acceptance`/`body`).
- A summary of what was filed, what was skipped as a duplicate, and what was
  left over the cap.

## Dedupe & cap

Before filing anything, `explore` reads the existing titles in
`docs/tasks/draft/` and `docs/tasks/in-progress/` and skips findings that
overlap. This keeps repeated runs from flooding the backlog with the same
finding restated. The 5-task cap is a per-run ceiling, not a total — run it
again later for more.

## How it differs from `/task new`

- **`/task new <idea>`** — you already have an idea; `task-author` turns it
  into one schema-valid task.
- **`/explore [path]`** — you don't have an idea yet; `explore` proactively
  scans and finds several, filing each as its own task.

Both land in `docs/tasks/draft/` and use the same human gate: you review, then
move what you want to `docs/tasks/in-progress/`.

## Anti-patterns

- **Feature ideas** — this is repo-health scanning, not product brainstorming.
  Stick to refactors, dead code, tech debt, stale docs.
- **Editing source** — `explore` only ever writes task files.
- **Ignoring the cap** — filing more than ~5 per run turns review into a chore;
  respect it and let a human triage before the next pass.
- **Duplicate filings** — always dedupe against `draft/` and `in-progress/`
  before writing.
