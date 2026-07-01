---
description: Scan the repo for improvement opportunities (refactors, dead code, tech debt) unrelated to any /loop goal, and file them as draft backlog tasks
agent: explore
subtask: true
---

Scan the repo (or the path/area named in `$ARGUMENTS`, if any) for potential
improvements — refactors, dead code, duplicated logic, tech debt, stale docs —
that are not part of any active `/loop` goal.

**$ARGUMENTS**

Delegated to the `explore` subagent, which scans, dedupes against existing
`docs/tasks/draft/` and `docs/tasks/in-progress/` tasks, caps at ~5 findings
per run, and writes one schema-valid task file per surviving finding into
`docs/tasks/draft/`. Review the drafts, then move the ones you want to
`docs/tasks/in-progress/` to run them with `/loop next`.
