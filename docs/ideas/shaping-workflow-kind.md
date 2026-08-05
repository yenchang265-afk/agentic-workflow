# Shaping Workflow Kind

## Problem Statement

How might we make `plan-router`'s skill chains deterministic when they must
run unattended? The route card (in `plan-router` → "The route card") makes an
attended chain reproducible — same ask + same discovered facts → same path —
but it is still prose the model follows. A chain that *must* complete cannot
ride on prose: per AGENTS.md, behavior that must be reliable is a mechanism,
never an instruction.

## Recommended Direction

Encode shaping as a declarative workflow kind under
`packages/core/workflows/shaping/` — the same manifest + stage-prompt shape as
the engineering kind, run by the existing `@agentic-workflow/core`
interpreter. Stages mirror the route card's arms: explore → interview →
refine → spec → plan. The engine owns sequencing; the model only executes
inside a stage. Conditional edges (bail, interview insertion on a surfaced
decision cluster) become the manifest's verdict arms; human-latency steps
(interview questions, refine choices) park at gates the way `plan-review/`
does today, so unattended runs block visibly instead of guessing.

Ad-hoc mode keeps the prose route card — this kind is for chains that need
guarantees, not a replacement for attended shaping.

## Key Assumptions to Validate

- [ ] The manifest's verdict/`onFail`/`onPass` arms can express the route
      card's conditional exits without a new arm type — check `workflow.json`'s
      schema against the bail and insert-interview cases before designing
- [ ] A park gate can carry a question set to the human (plan-review-style)
      without a new gate mechanism
- [ ] A shaping run's output (spec + plan) can hand off into the engineering
      kind's queue without manual re-entry

## MVP Scope

One manifest with the codebase-holder route only (explore → spec → plan),
bail as its single conditional exit, parking the spec at the existing
plan-review gate. Human-holder and nobody-holder routes, and the
insert-interview edge, come after the interpreter assumptions hold.

## Not Doing (and Why)

- Stop-hook route enforcement for ad-hoc mode (tier 2) — hold until route
  drift is observed twice, per AGENTS.md's second-occurrence rule; the route
  card's verification lines are the current guard
- Wiring `plan-router` into the engineering loop's `new` verb — separate
  follow-up, already noted on PR #237
- A fixed linear chain with no conditional exits — the bail and
  insert-interview edges exist on purpose; determinism means same facts →
  same path, not one path always

## Open Questions

- Does a shaping run belong to the existing `docs/tasks/` lifecycle (a task
  in `queued/` that a shaping claim drives to `plan-review/`), or is it its
  own work source like the sitters?
- Which stages run as check stages (verdict-bearing) versus plain stages —
  does an interview stage need a verdict contract at all?
