---
description: Enter the TRIAGE stage of the PR-sitter loop — inspect a pull request read-only and emit a findings list plus a verdict
agent: workflow-pr-triage
subtask: true
---

Run the **TRIAGE** stage of the PR-sitter loop
(triage → fix → verify → publish) on:

**$ARGUMENTS**

Delegated to the `workflow-pr-triage` subagent, which inspects the PR (comments,
checks, conflict state) read-only, emits a structured findings list, and
records a `workflow_verdict` (PASS = actionable work for the fix stage; FAIL =
nothing to do; ERROR = could not inspect).
