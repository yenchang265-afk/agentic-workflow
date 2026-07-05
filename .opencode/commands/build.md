---
description: Enter the BUILD stage of the agentic loop — implement the approved plan test-first, or apply a REVIEW stage's fix requests
agent: loop-build
subtask: true
---

Run the **BUILD** stage of the agentic engineering loop
(plan → build → verify → review) on:

**$ARGUMENTS**

Delegated to the `build` subagent, which implements the approved plan test-first
with surgical diffs — or, on a re-build after a VERIFY or REVIEW FAIL, applies
that check's feedback. This is the only stage that writes code; in an automatic
loop it runs only on a task whose plan was approved via `/agent-loop-task approve-plan`.
Relay the diff summary and stop — the next stage (verify) takes over.
