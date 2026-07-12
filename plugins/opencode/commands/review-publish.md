---
description: Enter the PUBLISH stage of the review-sitter loop — post the drafted review as exactly one PR comment
agent: loop-review-publish
subtask: true
---

Run the **PUBLISH** stage of the review-sitter loop
(fetch → assess → publish) on:

**$ARGUMENTS**

Delegated to the `loop-review-publish` subagent, which posts the drafted
review as exactly ONE comment framed as an automated first pass. It never
approves, votes, pushes, or merges.
