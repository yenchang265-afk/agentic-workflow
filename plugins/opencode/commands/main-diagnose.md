---
description: Enter the DIAGNOSE stage of the main-sitter loop — reproduce the red head, bisect to the culprit, and emit a remedy work order plus a verdict
agent: workflow-main-diagnose
subtask: true
---

Run the **DIAGNOSE** stage of the main-sitter loop
(diagnose → remedy → verify → publish) on:

**$ARGUMENTS**

Delegated to the `workflow-main-diagnose` subagent, which reproduces the failure
on the pinned red head, bisects when needed, classifies it (fix-forward /
revert / flake), and records a `workflow_verdict` (PASS = remedy warranted; FAIL
= flake or recovered; ERROR = could not reproduce).
