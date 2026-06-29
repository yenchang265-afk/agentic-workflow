---
name: explore
description: Reference for the EXPLORE stage of the agentic engineering loop. Use when starting work on an unfamiliar area, when scope is uncertain, or before planning a change — to understand existing code and find reusable patterns first.
---

# EXPLORE stage

The first stage of the agentic engineering loop:

```
EXPLORE → plan → build → verify
   ▲                        │
   └────────  loop  ────────┘
```

EXPLORE exists to **replace assumptions with evidence** before any plan or code is
written. Skipping it is the most common cause of rework: code that duplicates an
existing utility, plans built on a misread of how the system actually works.

## When to run it

- Starting on an unfamiliar area or codebase.
- Scope is uncertain or spans multiple subsystems.
- Before proposing a plan for any non-trivial change.

Skip it only for truly isolated, well-understood edits (a typo, a one-line fix in
a file you already know).

## Inputs & outputs

- **Input:** a target — an area, file, feature, or question.
- **Output:** a `file:line` findings map, a summary of how the pieces connect, a
  list of **reusable** functions/patterns, and open questions for the plan stage.
  Output is *understanding*, never edits or a plan.

## How to run it

The stage ships two tools:

- **`/explore <target>`** — the command that enters the stage and delegates to the subagent.
- **`explore` subagent** — a read-only locator (Read/Grep/Glob only) that produces the findings.

## Checklist

- [ ] Found the entry points and key types for the target.
- [ ] Traced the main call paths / data flow.
- [ ] Searched for existing utilities and patterns to reuse.
- [ ] Captured `file:line` references, not vague descriptions.
- [ ] Listed open questions for the plan stage.

## Anti-patterns

- **Coding during explore** — no edits or fixes; this stage only reads.
- **Planning prematurely** — defer the "what to do" to the plan stage.
- **Shallow search** — one grep is not exploration; cover naming variants and call sites.
- **Ignoring reuse** — failing to surface existing code leads to duplication later.
