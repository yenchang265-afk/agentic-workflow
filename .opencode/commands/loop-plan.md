---
description: Draft a backlog task by interviewing you, plan it, or approve the plan for execution by /loop
agent: loop-plan-author
subtask: true
---

Plan authoring for the agentic loop — planning happens **here**, before the
loop; `/loop` only executes approved plans. `$ARGUMENTS` selects the mode:

- **`/loop-plan new <idea>`** — turn a rough idea into a **planless draft**
  in `docs/tasks/draft/`. The agent always interviews you first (at minimum
  one restate-and-confirm question; a full interview when the idea is vague)
  to pin down what you want to achieve and the testable acceptance criteria,
  then writes the draft and stops. Drafting and planning are two steps by
  design — you review the draft before plan effort is spent.
- **`/loop-plan task <id>`** — plan a task (`<id>` = filename without `.md`).
  The plugin first moves a `docs/tasks/draft/` task to
  `docs/tasks/in-planning/` (audited + committed) **before** this turn; the
  agent then reads it, produces its `## Implementation Plan`, and writes it
  onto that same file in place. Use this after reviewing a draft, for
  `/explore`-filed drafts, and to re-plan a task whose loop hit the
  iteration cap.
- **`/loop-plan approve <id>`** — approve a planned task for execution. The
  plugin handles this deterministically **before** this turn starts: it
  validates the task has an `## Implementation Plan`, moves it to
  `docs/tasks/in-progress/` (the approved queue `/loop watch` claims from),
  appends an audited note, and commits the move. **Write nothing** — report
  the toast's outcome (approved / no plan yet / not found) and stop.

**$ARGUMENTS**

The flow is two-step by design: `/loop-plan new <idea>` interviews you and
writes a planless draft (`title`, `priority`, testable `acceptance`, body)
per the `task-backlog-management` schema, asking about Azure DevOps linkage
(skipping gracefully if no ADO MCP server is connected) and showing you the
draft for confirmation. Review the draft, then run `/loop-plan task <id>` to
have the relevant code read and the Implementation Plan written. Review the
plan and run `/loop-plan approve <id>` — then `/loop task <id>` or a
`/loop watch` session executes it.
