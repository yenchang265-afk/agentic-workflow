---
description: Enter the SCAN stage of the dep-sitter loop — confirm the dependency advisory/upgrade is still real and emit a work order plus a verdict
agent: loop-dep-scan
subtask: true
---

Run the **SCAN** stage of the dep-sitter loop
(scan → upgrade → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-dep-scan` subagent, which confirms the advisory and
target version read-only (npm audit/outdated/view, or osv-scanner on the JVM), emits the upgrade
work order, and records a `loop_verdict` (PASS = upgrade needed; FAIL =
already resolved; ERROR = reports unreadable).
