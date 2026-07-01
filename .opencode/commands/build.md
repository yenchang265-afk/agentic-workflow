---
description: Enter the BUILD stage of the agentic loop — implement the approved plan test-first
agent: build
subtask: true
---

Run the **BUILD** stage of the agentic engineering loop
(plan → build → verify) on:

**$ARGUMENTS**

Delegated to the `build` subagent, which implements the approved plan test-first
with surgical diffs. This is the only stage that writes code; in an automatic loop
it runs only after a human has approved the plan. Relay the diff summary and
stop — the next stage (verify) takes over.
