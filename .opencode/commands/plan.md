---
description: Enter the PLAN stage of the agentic loop — turn exploration into a review-sized implementation plan
agent: plan
subtask: true
---

Run the **PLAN** stage of the agentic engineering loop
(explore → plan → build → verify) on:

**$ARGUMENTS**

Delegated to the read-only `plan` subagent, which turns the goal and any explore
findings into an ordered, review-sized implementation plan with explicit
acceptance criteria. Relay its plan and stop — the next stage (build) takes over,
and in an automatic loop a human reviews the plan before any code is written.
