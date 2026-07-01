---
description: Author a structured backlog task from a rough idea and write it to docs/tasks/draft/
agent: task-author
subtask: true
---

Create a new backlog task from this idea (ignore a leading `new`):

**$ARGUMENTS**

Delegated to the `task-author` subagent, which turns the idea into a
schema-valid task file (`title`, `priority`, testable `acceptance`, body) and
writes it to `docs/tasks/draft/`. Review the draft, then move it to
`docs/tasks/in-progress/` to make it runnable with `/loop next`.
