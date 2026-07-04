---
description: Author a backlog task with its Implementation Plan, plan an existing task in place, or approve a plan for execution by /loop
agent: loop-plan-author
subtask: true
---

Plan authoring for the agentic loop — planning happens **here**, before the
loop; `/loop` only executes approved plans. `$ARGUMENTS` selects the mode:

- **`/loop-plan new <idea>`** — turn a rough idea into one schema-valid task
  file **with** an `## Implementation Plan` section, written to
  `docs/tasks/in-planning/`. You confirm the task and its plan live in this
  turn — that confirmation replaces the old manual `draft/ → in-planning/`
  move.
- **`/loop-plan task <id>`** — plan an existing task (in `docs/tasks/draft/`
  or `docs/tasks/in-planning/`, `<id>` = filename without `.md`): read it,
  produce its `## Implementation Plan`, and write it onto that same file in
  place. Use this for `/explore`-filed drafts, and to re-plan a task whose
  loop hit the iteration cap.
- **`/loop-plan approve <id>`** — approve a planned task for execution. The
  plugin handles this deterministically **before** this turn starts: it
  validates the task has an `## Implementation Plan`, moves it to
  `docs/tasks/in-progress/` (the approved queue `/loop watch` claims from),
  appends an audited note, and commits the move. **Write nothing** — report
  the toast's outcome (approved / no plan yet / not found) and stop.

**$ARGUMENTS**

The `loop-plan-author` subagent authors the task (`title`, `priority`,
testable `acceptance`, body) per the `task-backlog-management` schema, asks
about Azure DevOps linkage (skipping gracefully if no ADO MCP server is
connected), shows you the draft for confirmation, then reads the relevant
code and produces the Implementation Plan. After it writes the file, review
the plan and run `/loop-plan approve <id>` — then `/loop task <id>` or a
`/loop watch` session executes it.
