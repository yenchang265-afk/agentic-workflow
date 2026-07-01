---
name: plan
description: Reference for the PLAN stage of the agentic engineering loop — the loop's first stage. Use to turn a goal into an ordered, review-sized implementation plan with testable acceptance criteria; PLAN reads the relevant code itself before planning.
---

# PLAN stage

The first stage of the agentic engineering loop:

```
PLAN → build → verify
   ▲                │
   └──────  loop  ───┘
```

PLAN reads the relevant code itself, then converts what it finds into a
concrete, ordered set of steps a human can review **before** any code is
written. In the automatic loop this is the gate: `/loop <goal>` fires PLAN
first, then the loop pauses for a human to approve the plan (`/loop go`)
before build edits anything.

## When to run it

- First thing when starting on any change — PLAN reads what it needs directly.
- Before BUILD on any non-trivial change.

## Inputs & outputs

- **Input:** a goal (free text, or a backlog task's title/body/acceptance
  criteria) — PLAN reads the relevant code itself; there's no separate
  findings hand-off.
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
- **Skipping the read** — planning without reading the relevant code first
  produces a plan BUILD can't execute.
