---
description: Enter the VERIFY stage of the agentic loop — check the build against the acceptance criteria and emit a verdict
agent: workflow-verify
subtask: true
---

Run the **VERIFY** stage on:

**$ARGUMENTS**

This stage is shared by four workflow kinds: engineering
(plan → build → verify → review), pr-sitter (triage → fix → verify → publish),
dep-sitter (scan → upgrade → verify → publish) and main-sitter
(diagnose → remedy → verify → publish).

Delegated to the `workflow-verify` subagent, which runs the tests and checks the
work against the acceptance criteria, then records its verdict with the
`workflow_verdict` tool.
