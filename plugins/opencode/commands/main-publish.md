---
description: Enter the PUBLISH stage of the main-sitter loop — push the verified remedy branch, open a draft PR, and notify the culprit PR
agent: loop-main-publish
subtask: true
---

Run the **PUBLISH** stage of the main-sitter loop
(diagnose → remedy → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-main-publish` subagent, which pushes the verified
main-sitter/ remedy branch, opens a DRAFT pull request onto the watched
branch, and comments once on the culprit PR. It never pushes the watched
branch and never merges.
