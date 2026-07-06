---
description: Enter the FIX stage of the PR-sitter loop — address the triage findings on the PR's branch with local commits
agent: loop-pr-fix
subtask: true
---

Run the **FIX** stage of the PR-sitter loop
(triage → fix → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-pr-fix` subagent, which addresses each triage finding
(failing checks, requested changes, conflicts) with surgical test-first
commits on the PR's existing branch. It never pushes — publish does, after
verification.
