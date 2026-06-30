---
description: Enter the VERIFY stage of the agentic loop — check the build against the acceptance criteria and emit a verdict
agent: verify
subtask: true
---

Run the **VERIFY** stage of the agentic engineering loop
(explore → plan → build → verify) on:

**$ARGUMENTS**

Delegated to the `verify` subagent, which runs the tests and checks the build
against the plan's acceptance criteria, then emits a machine-readable verdict
(`LOOP_VERIFY: PASS` or `LOOP_VERIFY: FAIL`). The loop driver reads that verdict
to decide whether to finish or re-plan.
