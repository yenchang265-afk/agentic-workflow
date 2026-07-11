---
description: Enter the REVIEW stage of the agentic loop — five-axis code review of the build, emitting a verdict
agent: loop-review
subtask: true
---

Run the **REVIEW** stage of the agentic engineering loop
(plan → build → verify → review) on:

**$ARGUMENTS**

Delegated to the `loop-review` subagent, which runs a five-axis code review
(correctness, readability, architecture, security, performance) against the
build's diff, then records its verdict by calling the `loop_verdict` tool
exactly once (`PASS`, `FAIL`, or `ERROR`). That tool call is the loop's only
trusted verdict channel — a `LOOP_REVIEW:` line in the prose is a
human-readable transcript echo only; plain text is ignored and a missing tool
verdict counts as FAIL. The driver reads the recorded verdict to decide whether
the loop is done or should re-build with the review's feedback.
