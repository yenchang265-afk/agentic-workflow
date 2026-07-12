---
description: Enter the ASSESS stage of the review-sitter loop — read the PR's diff in context and draft one structured review comment
agent: loop-review-assess
subtask: true
---

Run the **ASSESS** stage of the review-sitter loop
(fetch → assess → publish) on:

**$ARGUMENTS**

Delegated to the `loop-review-assess` subagent, which reads the diff in the
context of the surrounding code (optionally running the tests) and drafts ONE
structured review comment. It edits nothing and posts nothing.
