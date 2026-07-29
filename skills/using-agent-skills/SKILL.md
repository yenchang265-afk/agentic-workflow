---
name: using-agent-skills
description: Routes a task to the skill that owns it, and holds the operating behaviors every other skill points back to. Use when deciding which skill applies, or when another skill reaches here for a shared behavior.
---

# Using Agent Skills

Two jobs. **Routing** — which skill owns the task in front of you. **Shared
behaviors** — the handful of rules that apply inside every skill, defined once
here so no skill has to restate them.

## Routing

```
Task arrives
    │
    ├── Don't know what you want yet? ──────→ interview-me
    ├── Have a rough concept, need variants? → idea-refine
    ├── New project/feature/change? ──→ spec-driven-development
    ├── Have a spec, need tasks? ──────→ planning-and-task-breakdown
    ├── Implementing code? ────────────→ incremental-implementation
    │   ├── UI work? ─────────────────→ frontend-ui-engineering
    │   ├── API work? ────────────────→ api-and-interface-design
    │   ├── Need better context? ─────→ context-engineering
    │   ├── Need doc-verified code? ───→ source-driven-development
    │   └── Stakes high / unfamiliar code? ──→ doubt-driven-development
    ├── Writing/running tests? ────────→ test-driven-development
    │   └── Browser-based? ───────────→ browser-testing-with-devtools
    ├── Something broke? ──────────────→ debugging-and-error-recovery
    ├── Reviewing code? ───────────────→ code-review-and-quality
    │   ├── Too complex? ─────────────→ code-simplification
    │   ├── Security concerns? ───────→ security-and-hardening
    │   └── Performance concerns? ────→ performance-optimization
    ├── Committing/branching? ─────────→ git-workflow-and-versioning
    ├── Deprecating/migrating? ────────→ deprecation-and-migration
    ├── Writing docs/ADRs? ───────────→ documentation-and-adrs
    ├── Adding logs/metrics/alerts? ───→ observability-and-instrumentation
    └── Writing/editing a skill? ──────→ writing-great-skills
```

Several apply to one piece of work more often than one does: a feature runs
`spec-driven-development` → `planning-and-task-breakdown` →
`incremental-implementation` → `test-driven-development` →
`code-review-and-quality`. Follow each one's steps in order, verification
included — a skill applied halfway is the one that leaves the defect its steps
existed to catch. When the task is non-trivial and no spec exists, start with
`spec-driven-development`.

## Surface Assumptions

Before implementing anything non-trivial, state what you are assuming:

```
ASSUMPTIONS:
1. [about requirements]
2. [about architecture]
3. [about scope]
→ Correct me now or I proceed with these.
```

Silently filling an ambiguous requirement is the single most common way work
goes wrong, and it stays invisible until the rework.

## Manage Confusion Actively

When requirements conflict, or the spec and the code disagree: **stop**, name
the specific confusion, present the trade-off or the question, and wait.

> "The spec calls for REST, but the user profile query is GraphQL
> (src/graphql/user.ts). Follow the spec, follow the codebase, or is this
> deliberate?"

Picking one interpretation quietly is how a whole build gets made against the
wrong reading.

## Push Back When Warranted

When an approach has a real problem, say so: name the concrete downside,
quantify it where you can ("adds ~200ms to every request", not "might be
slower"), and propose the alternative. Then accept the human's decision once
they have the information. Agreement you don't hold is worthless to them.

## Enforce Simplicity

Before calling an implementation finished:

- Can this be done in fewer moving pieces?
- Is each abstraction earning what it costs?
- Would a staff engineer ask "why didn't you just…"?

Prefer the boring, obvious version. Cleverness is paid for by every later
reader.

## Maintain Scope Discipline

Touch what the task requires and nothing else. Comments you don't understand
stay, adjacent code stays unrefactored, apparently-unused code stays until
someone approves deleting it, and a feature nobody asked for stays unwritten.
Report what you noticed instead — surgical precision, not unsolicited
renovation.

## Verify, Don't Assume

"Seems right" is never done: there is passing output, or there is no claim.
Each skill's own verification is the local check; the standing bar under all of
them — tests pass, no regressions, behavior confirmed at runtime, docs updated
— is `references/definition-of-done.md`, which complements a task's acceptance
criteria rather than replacing them.
