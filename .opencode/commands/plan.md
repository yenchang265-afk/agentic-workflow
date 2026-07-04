---
description: Ad-hoc planning — turn a raw goal into a spec-bounded, review-sized implementation plan (read-only, standalone)
agent: loop-plan
subtask: true
---

Produce an implementation plan for:

**$ARGUMENTS**

Delegated to the read-only `plan` subagent, which reads the relevant code
itself, sharpens and bounds the raw goal into a short problem/non-goals
framing, then turns that into an ordered, review-sized implementation plan
with explicit acceptance criteria. Relay its plan and stop. This is a
standalone tool — to plan a backlog task for the automatic loop (build →
verify → review), use `/agent-loop-plan` instead, which persists the plan onto the
task file.
