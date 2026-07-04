---
description: Scan the repo for improvement opportunities (refactors, dead code, tech debt) unrelated to any /agent-loop goal, and file them as draft backlog tasks
agent: loop-explore
subtask: true
---

Scan the repo (or the path/area named in `$ARGUMENTS`, if any) for potential
improvements — refactors, dead code, duplicated logic, tech debt, stale docs —
that are not part of any active `/agent-loop` goal.

**$ARGUMENTS**

Delegated to the `explore` subagent, which scans, dedupes against existing
`docs/tasks/draft/`, `docs/tasks/in-planning/`, and `docs/tasks/in-progress/`
tasks, caps at ~5 findings per run, and writes one schema-valid task file per
surviving finding into `docs/tasks/draft/`. Review the drafts, then plan the
ones you want with `/agent-loop-plan task <id>` and approve them with
`/agent-loop-plan approve <id>`.
