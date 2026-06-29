---
description: Enter the EXPLORE stage of the agentic loop — map the code before planning or building
agent: explore
subtask: true
---

You are entering the **EXPLORE** stage of the agentic engineering loop
(explore → plan → build → verify).

Target of this exploration: **$ARGUMENTS**

This runs as the read-only `explore` subtask. As that subagent:

1. Locate the code relevant to the target — entry points, key types, call sites.
2. Trace how the relevant pieces connect (who calls what, where data flows).
3. Surface **existing functions, utilities, and patterns that can be reused**, so
   later stages avoid writing net-new code.
4. Return a concise `file:line` findings table plus a short prose summary.

Goal of this stage is **understanding only**: no edits, no fixes, no
implementation plan yet. Return the findings and stop — the next stage (plan)
decides what to do with them.
