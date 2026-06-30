---
name: build
description: Reference for the BUILD stage of the agentic engineering loop. Use after a plan is approved — to implement it test-first with surgical diffs. This is the only stage that writes code.
---

# BUILD stage

The third stage of the agentic engineering loop:

```
explore → plan → BUILD → verify
   ▲                        │
   └────────  loop  ────────┘
```

BUILD turns the approved plan into code. It is the **only writing stage**, which
is why the automatic loop pauses for a human plan-approval gate (`/loop go`)
before BUILD runs — a human signs off on the plan before any file is edited.

## When to run it

- After PLAN, once the plan and its acceptance criteria are approved.
- Never before a plan exists — building without a plan is how scope creep starts.

## Inputs & outputs

- **Input:** a goal + the approved plan (steps, files, acceptance criteria, reuse).
- **Output:** a surgical diff implementing the plan test-first, plus a summary of
  what changed and the local test status.

## How to run it

- **`/build <goal + plan>`** — enters the stage and delegates to the `build` subagent.
- **`build` subagent** — can edit files and run commands; works test-first.

## Checklist

- [ ] Read every file before editing it.
- [ ] Wrote a failing test per acceptance criterion (RED) before implementing.
- [ ] Implemented the minimum to pass (GREEN), reusing cited utilities.
- [ ] Diff is surgical — only what the plan needs, no reformatting.
- [ ] Tests run locally; no test weakened to force a pass.

## Anti-patterns

- **Code before test** — violates the loop's TDD contract.
- **Redesigning the plan** — if the plan is wrong, stop and flag it, don't improvise.
- **Scope creep / drive-by edits** — keep the diff reviewable.
- **Committing or opening a PR** — the human does that after verify passes.
