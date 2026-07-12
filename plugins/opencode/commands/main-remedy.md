---
description: Enter the REMEDY stage of the main-sitter loop — write the smallest fix or construct the revert that turns the red head green
agent: loop-main-remedy
subtask: true
---

Run the **REMEDY** stage of the main-sitter loop
(diagnose → remedy → verify → publish) on:

**$ARGUMENTS**

Delegated to the `loop-main-remedy` subagent, which writes the forward fix or
constructs the revert per the diagnosis and commits locally. It never pushes
(publish's job) and never touches the watched branch.
