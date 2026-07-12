---
description: Enter the PUBLISH stage of the dep-sitter loop — push the verified upgrade branch and open a draft PR
agent: loop-dep-publish
subtask: true
---

Run the **PUBLISH** stage of the dep-sitter loop
(scan → upgrade → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-dep-publish` subagent, which pushes the verified
feature branch and opens a DRAFT pull request naming the advisory, impact,
and verification result. It never merges and never marks the PR ready.
