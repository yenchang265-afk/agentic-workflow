---
name: plan-router
description: Routes unshaped work to the right thinking skill by who holds the missing information — codebase, human, or nobody — sized against the task scale first. Use when work arrives without a spec — a vague ask, a raw idea, a symptom without a cause — or when unsure which planning skill applies.
---

# Plan Router

Unshaped work fails differently depending on **who holds the missing
information**: the codebase (nobody has read it yet), the human (they haven't
decided yet), or nobody (the shape must be invented). Each holder has a skill
built to extract from it, and running the wrong one wastes the scarcest
resource — an interview cannot read code, and an exploration cannot read
minds. This skill classifies, states the route, dispatches, and stops; the
dispatched skill is then followed fully, not summarized.

Route in order — each step either exits or falls through to the next.

## Step 0 — Size triage, before any questions

Judge the ask against the size table and split triggers in
`planning-and-task-breakdown` → "Size each task". Any trigger firing — two or
more independent subsystems, "and" in the title, more than 3 acceptance
bullets, more than one focused session — means **split first**: decompose into
vertical slices (`planning-and-task-breakdown` branch A; inside the loop,
`task-backlog-management` → "Slicing a heavy idea") and route each slice
through this rubric separately. Questions asked of an unsplit multi-subsystem
ask get answered at the wrong granularity and must be re-asked per slice —
split before asking anything.

## Step 1 — The skip arm

Work is **well understood** when its requirements are unambiguous and
self-contained (`spec-driven-development`'s skip rule) *and* predict-three
passes on the ask as written (`interview-me`'s stop test). Then no thinking
skill runs:

| Well-understood work | Route |
|---|---|
| XS/S, single file, obvious scope | Implement directly (`incremental-implementation`) — acceptance criteria, not a document |
| M or larger, or multi-module/architectural, but requirements concrete | `spec-driven-development` → `planning-and-task-breakdown` |
| One already-scoped task needing its plan | `planning-and-task-breakdown` branch B |

## Step 2 — Who holds the missing information?

| Signals in the ask | Holder | Route |
|---|---|---|
| A symptom without a cause ("feels slow", "sometimes double-fires"); a question about unfamiliar code; a choice that must be judged against what the code actually does | **The codebase** | `codebase-exploration`, then spec or plan per its exit — or bail, nothing owed |
| Missing who/why/success/constraint; a conventional ask ("build me a dashboard"); two values in tension with no stated winner; contested vocabulary | **The human** | `interview-me` → (`idea-refine` if the shape is still open) → `spec-driven-development` → `planning-and-task-breakdown` |
| Intent confirmed but shape unsettled; alternatives never examined; a direction that must be invented | **Nobody yet** | `idea-refine` → `spec-driven-development` → `planning-and-task-breakdown` |
| A live, reproducible failure | Not this router | `debugging-and-error-recovery` — failures have an owner already |

## Step 3 — Mixed holders: cheapest source first

**Facts are looked up, decisions are asked, shapes are refined — in that
order.** Codebase facts cost agent turns, which are cheap and tireless; human
decisions cost human turns, which are scarce. When both hold pieces, run
`codebase-exploration` first and carry the discovered facts into
`interview-me` as its `GUESS:` lines — every fact looked up is a question the
human never has to answer.

## The route card

The chain is decided here, once. Before the first dispatch, state the whole
route as one line of data, conditional exits included:

```
ROUTE: codebase-exploration → spec-driven-development → planning-and-task-breakdown
  exits: exploration may bail (route ends); a surfaced decision cluster
  inserts interview-me after exploration
```

Every skill on the route, on finishing, invokes the next skill the card
names instead of re-deciding from its own cross-references — the card is the
chain's single decision point, and each skill's verification holds its own
hand-off. The one legal divergence is a conditional exit named on the card
firing: restate the amended `ROUTE:` line at the divergence, then follow it.

## Secondary considerations

| Consideration | Effect on the route |
|---|---|
| Must something survive the session? | Exploration owes nothing; `interview-me` offers `docs/intent/`; `idea-refine` offers `docs/ideas/`; a spec always survives (version-controlled) |
| Unattended context — loop stage, CI, scheduled run? | Human-latency routes (`interview-me`, `idea-refine`'s questions) are blockers to report, not gaps to guess at — see `interview-me` → "Loading Constraints". `codebase-exploration` stays legal. |

## Verification

- [ ] Size triage ran before any question — a split ask was sliced, and each slice routed separately
- [ ] The skip arm was tested before any interview or exploration started
- [ ] The chosen arm names the signal that selected it
- [ ] On mixed holders, facts were looked up before decisions were asked
- [ ] The full `ROUTE:` line was stated before the first dispatch, conditional exits named
- [ ] In an unattended context, no human-latency route was chosen
- [ ] The dispatched skill was then followed fully, steps and verification included
