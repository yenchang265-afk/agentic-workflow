---
description: Enter the EXPLORE stage of the agentic loop — map the code before planning or building
argument-hint: "[area, file, or question]"
---

You are entering the **EXPLORE** stage of the agentic engineering loop
(explore → plan → build → verify).

Target of this exploration: **$ARGUMENTS**

Delegate the actual search to the read-only `explore` subagent (do not explore
inline, and do not edit anything yourself). Instruct it to:

1. Locate the code relevant to the target — entry points, key types, call sites.
2. Trace how the relevant pieces connect (who calls what, where data flows).
3. Surface **existing functions, utilities, and patterns that can be reused**, so
   later stages avoid writing net-new code.
4. Return a concise `file:line` findings table plus a short prose summary.

Goal of this stage is **understanding only**: no edits, no fixes, no
implementation plan yet. When the subagent returns, relay its findings and stop —
the next stage (plan) decides what to do with them.
