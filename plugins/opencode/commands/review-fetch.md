---
description: Enter the FETCH stage of the review-sitter loop — confirm the requested review is still wanted and emit a review work order plus a verdict
agent: workflow-review-fetch
subtask: true
---

Run the **FETCH** stage of the review-sitter loop
(fetch → assess → publish) on:

**$ARGUMENTS**

Delegated to the `workflow-review-fetch` subagent, which confirms the review is
still wanted, sizes the diff, emits the review work order, and records a
`loop_verdict` (PASS = reviewable; FAIL = nothing to review; ERROR = could
not inspect).
