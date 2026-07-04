---
description: Draft a new backlog task from an idea (optionally linked to Azure DevOps), filed into docs/tasks/draft/
argument-hint: new <idea>
---

Draft a backlog task from: `$ARGUMENTS`

Spawn the **`loop-task-author`** subagent (Task tool) to draft a single
schema-valid task file into `docs/tasks/draft/`. It will confirm the details with
the user before writing, and follow the Azure DevOps linkage protocol in the
`task-backlog-management` skill if the work traces to a work item and that MCP
server is connected. New tasks always land in `draft/` for a human to triage.
