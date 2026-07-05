---
description: Ad-hoc read-only implementation plan for a goal — relayed as chat, nothing persisted
argument-hint: <goal>
---

Spawn the **`loop-plan`** subagent (Task tool) to produce a read-only
implementation plan for: `$ARGUMENTS`

Relay its plan back verbatim. Nothing is written to disk — if the user wants
a persisted, loop-executable plan, point them at `/agent-loop-task new
<idea>` (draft + interview) — the loop's PLAN stage plans the task right
before execution, once it's approved into the queue.
