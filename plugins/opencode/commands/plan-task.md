---
description: Enter the PLAN stage of the agentic loop — write the claimed task's Implementation Plan onto its file, right before execution
agent: workflow-plan-author
subtask: true
---

Run the **PLAN** stage of the agentic engineering loop
(plan → build → verify → review) in mode `task` on:

**$ARGUMENTS**

Delegated to the `workflow-plan-author` subagent in task mode, which reads the
task and the relevant code and writes the `## Implementation Plan` onto the
task file **in place** (the prompt above carries the task file's path). It
never touches source code. This stage is fired by the loop driver on a
claimed `queued/` task — when it returns, the driver parks the task in
`plan-review/` for the human plan gate (`/agentic-workflow:engineering approve`).
Relay the plan summary and stop.
