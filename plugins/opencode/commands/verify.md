---
description: Enter the VERIFY stage of the agentic loop — check the build against the acceptance criteria and emit a verdict
agent: workflow-verify
subtask: true
---

Run the **VERIFY** stage on:

**$ARGUMENTS**

This stage is shared by both workflow kinds: the engineering loop
(plan → build → verify → review) and the pr-sitter loop
(triage → fix → verify → publish).

Delegated to the `workflow-verify` subagent, which runs the tests and checks the
work against the acceptance criteria, then records its verdict by calling the
`workflow_verdict` tool exactly once (`PASS`, `FAIL`, or `ERROR`). That tool call is
the loop's only trusted verdict channel — a `WORKFLOW_VERIFY:` line in the prose is
a human-readable transcript echo only; plain text is ignored and a missing tool
verdict counts as FAIL. The driver reads the recorded verdict to decide whether
to advance or re-build.
