---
description: Gather Azure DevOps PR data through the read-only `ado` MCP tools so the PR sitter can claim work in codePlatform 'ado-mcp' mode
agent: loop-pr-poll
subtask: true
---

Gather the Azure DevOps pull-request data the PR sitter needs, following this
fetch spec exactly:

**$ARGUMENTS**

Delegated to the `loop-pr-poll` subagent, which calls only the read-only `ado`
MCP tools, assembles the bundle described above, and returns it through the
`loop_ado_data` tool — the single channel back to the poller.
