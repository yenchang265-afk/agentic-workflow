---
description: Enter the BUILD stage of the agentic loop — implement the approved plan test-first, or apply a REVIEW stage's fix requests
agent: build
subtask: true
---

Run the **BUILD** stage of the agentic engineering loop
(define → plan → build → verify → review → ship) on:

**$ARGUMENTS**

Delegated to the `build` subagent, which implements the approved plan test-first
with surgical diffs — or, on a re-build after a REVIEW FAIL, applies the
review's feedback. This is the only stage that writes code; in an automatic
loop it runs only after a human has approved the plan. Relay the diff summary
and stop — the next stage (verify) takes over.
