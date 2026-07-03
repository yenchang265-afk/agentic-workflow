---
description: Enter the PLAN stage of the agentic loop — turn a raw goal (or a re-plan request) into a spec-bounded, review-sized implementation plan
agent: plan
subtask: true
---

Run the **PLAN** stage of the agentic engineering loop
(plan → build → verify → review) on:

**$ARGUMENTS**

Delegated to the read-only `plan` subagent, which reads the relevant code
itself, sharpens and bounds the raw goal into a short problem/non-goals
framing, then turns that into an ordered, review-sized implementation plan
with explicit acceptance criteria. Relay its plan and stop — the next stage
(build) takes over, and in an automatic loop a human reviews the plan before
any code is written.
