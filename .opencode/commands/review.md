---
description: Enter the REVIEW stage of the agentic loop — five-axis code review of the build, emitting a verdict
agent: review
subtask: true
---

Run the **REVIEW** stage of the agentic engineering loop
(plan → build → verify → review) on:

**$ARGUMENTS**

Delegated to the `review` subagent, which runs a five-axis code review
(correctness, readability, architecture, security, performance) against the
build's diff, then emits a machine-readable verdict (`LOOP_REVIEW: PASS` or
`LOOP_REVIEW: FAIL`). The loop driver reads that verdict to decide whether the
loop is done or to re-build with the review's feedback.
