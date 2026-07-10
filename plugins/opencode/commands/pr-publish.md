---
description: Enter the PUBLISH stage of the PR-sitter loop — push the verified commits and reply to the addressed review comments
agent: loop-pr-publish
subtask: true
---

Run the **PUBLISH** stage of the PR-sitter loop
(triage → fix → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-pr-publish` subagent, which pushes the verified
commits to the PR branch and replies to each addressed finding via `gh`.
It never merges — that stays a human call.
