---
description: Enter the PLAN stage of the agentic loop — turn a spec (or a re-plan request) into a review-sized implementation plan
agent: plan
subtask: true
---

Run the **PLAN** stage of the agentic engineering loop
(define → plan → build → verify → review → ship) on:

**$ARGUMENTS**

Delegated to the read-only `plan` subagent, which reads the relevant code
itself and turns the goal (and, in the loop, the DEFINE stage's spec) into an
ordered, review-sized implementation plan with explicit acceptance criteria.
Relay its plan and stop — the next stage (build) takes over, and in an
automatic loop a human reviews the plan before any code is written.
