---
description: Enter the SHIP stage of the agentic loop — run the pre-launch checklist and draft a PR description and rollback plan
agent: ship
subtask: true
---

Run the **SHIP** stage of the agentic engineering loop
(define → plan → build → verify → review → ship) on:

**$ARGUMENTS**

Delegated to the `ship` subagent, which runs the pre-launch checklist and
drafts a PR description and rollback plan. This stage never pushes, opens a
PR, or deploys — in an automatic loop it runs only after a human has approved
the review, and the loop finishes here with a draft for the human to act on.
