---
description: Enter the REVIEW stage of the agentic loop — five-axis code review of the build, emitting a verdict
agent: workflow-review
subtask: true
---

Run the **REVIEW** stage of the agentic engineering loop
(plan → build → verify → review) on:

**$ARGUMENTS**

Delegated to the `workflow-review` subagent, which runs a five-axis code review
(correctness, readability, architecture, security, performance) against the
build's diff and records its verdict with the `workflow_verdict` tool.
