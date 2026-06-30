---
name: plan
description: Reference for the PLAN stage of the agentic engineering loop. Use after exploring an area and before writing code — to turn understanding into an ordered, review-sized implementation plan with testable acceptance criteria.
---

# PLAN stage

The second stage of the agentic engineering loop:

```
explore → PLAN → build → verify
   ▲                        │
   └────────  loop  ────────┘
```

PLAN converts the evidence gathered in EXPLORE into a concrete, ordered set of
steps a human can review **before** any code is written. In the automatic loop
this is the gate: explore → plan runs unattended, then the loop pauses for a
human to approve the plan (`/loop go`) before build edits anything.

## When to run it

- After EXPLORE, once you understand the area and what is reusable.
- Before BUILD on any non-trivial change.

## Inputs & outputs

- **Input:** a goal + the EXPLORE findings (`file:line` map, reusable patterns).
- **Output:** an ordered step list naming files to touch, a checklist of
  **testable acceptance criteria**, the existing code to reuse, and any risks.
  Output is a plan — never code or edits.

## How to run it

- **`/plan <goal>`** — enters the stage and delegates to the `plan` subagent.
- **`plan` subagent** — read-only (Read/Grep/Glob); produces the plan.

## Checklist

- [ ] Plan is built around reusable existing code, cited by `file:line`.
- [ ] Steps name the exact files to create/modify.
- [ ] Acceptance criteria are observable and testable (verify checks them).
- [ ] Large goals are split into ordered, review-sized slices.

## Anti-patterns

- **Coding during plan** — no edits; this stage only plans.
- **Vague acceptance criteria** — "works well" is not testable; the verify stage
  needs concrete conditions.
- **Oversized plans** — a plan too big to review in one sitting should be sliced.
- **Ignoring explore** — re-deriving what EXPLORE already found wastes the loop.
