---
description: Author a structured backlog task from a rough idea, optionally linked to an Azure DevOps work item, and write it to docs/tasks/draft/
agent: task-author
subtask: true
---

Create a new backlog task from this idea (ignore a leading `new`):

**$ARGUMENTS**

Delegated to the `task-author` subagent, which turns the idea into a
schema-valid task file (`title`, `priority`, testable `acceptance`, body) and
writes it to `docs/tasks/draft/`. It also asks whether an Azure DevOps work
item covers this task — linking an existing one or offering to create one
(always with your confirmation first) — skips that step gracefully if no
Azure DevOps MCP server is connected, and shows you the drafted task for
confirmation before writing it. Review the draft, then move it to
`docs/tasks/in-planning/` to make it runnable with `/loop next`.
