---
name: idea-refine
description: Opens a raw idea up with variations, then converges it to one direction with its assumptions named. Use when an idea's shape is still unsettled and needs stress-testing before a spec or plan, or when the user says "ideate".
---

# Idea Refine

Three phases, each doing one thing: **diverge** to find the versions of the
idea nobody said out loud, **converge** to kill all but the strongest, then
**sharpen** into a one-pager someone can act on. Stop there.

You are a thinking partner here, not a facilitator: direct, specific, and
willing to say an idea is weak (`using-agent-skills` → Push Back When
Warranted).

Upstream, `plan-router` dispatches here when intent is confirmed but the shape
must still be invented, and `interview-me` extracts what the user wants when
even the intent is unclear; this skill takes a clear intent whose *shape* is
still open. Downstream, `spec-driven-development` writes the chosen direction
down. When a `codebase-exploration` pass preceded this, its findings are
Phase 1's read-before-you-diverge material — already gathered, cite them.

Standing convictions that shape every phase: push toward the simplest version
that still solves the real problem; start from the user's experience and work
back to technology; "how it's usually done" is not a reason; focus comes from
saying no to good ideas, not from having no bad ones.

**Unsure of the rhythm — how hard to push back, how much a variation must
carry?** A worked session, vague concept to one-pager:
[`examples.md`](examples.md).

## Phase 1 — Understand and expand

1. **Restate as "How Might We…"** — one sentence. Restating it as a problem
   rather than a solution is what exposes that the solution was assumed.

2. **Ask 3–5 sharpening questions, no more**, via `AskUserQuestion`: who
   specifically is this for, what does success look like, what are the real
   constraints, what has been tried, why now. **Do not proceed until who it is
   for and what success looks like are both answered** — every later judgement
   depends on them.

3. **Generate 5–8 variations**, each through a different lens: inversion
   (do the opposite), constraint removal (no budget, time, or tech limit),
   audience shift, combination with an adjacent idea, radical simplification,
   the 10x-scale version, the expert lens (what a domain expert finds obvious
   and an outsider never would). More lenses and framings:
   [`frameworks.md`](frameworks.md) — pick what fits, don't run the catalogue.

   Push past what was asked for. Each variation carries the reason it exists,
   not just a label.

**In a codebase**, read before you diverge: `Glob`/`Grep`/`Read` for the
existing architecture, patterns, and prior art, and ground the variations in
what is actually there, citing files. The architecture is both a constraint and
an opportunity, and ignoring it produces variations that cannot be built.

**Done when** the "How Might We" line, the answers to who-it-is-for and what
success looks like, and 5–8 reasoned variations are all written — and the user
has reacted to them: resonance, pushback, or new context.

## Phase 2 — Evaluate and converge

1. **Cluster** what resonated into 2–3 directions that are meaningfully
   different from each other, not three shades of one idea.

2. **Stress-test each** on user value (painkiller or vitamin, and for whom),
   feasibility (the cost, and the hardest part), and differentiation (would
   anyone switch?). The full rubric is
   [`refinement-criteria.md`](refinement-criteria.md).

3. **Name the hidden assumptions** for each direction: what you are betting is
   true but have not validated, what would kill it, and what you are choosing
   to ignore for now and why. Sorting them into dealbreaker / important /
   nice-to-have: [`refinement-criteria.md`](refinement-criteria.md) →
   "Assumption Audit". This is the step ideation usually skips and the one that
   decides whether the idea survives contact.

**Done when** each surviving direction has its value, cost, and hidden
assumptions written down.

## Phase 3 — Sharpen and ship

```markdown
# [Idea Name]

## Problem Statement
[the "How Might We" framing]

## Recommended Direction
[which, and why — 2-3 paragraphs]

## Key Assumptions to Validate
- [ ] [assumption — and how to test it]

## MVP Scope
[the minimum version that tests the core assumption: what is in, what is out —
 scoping principles: `refinement-criteria.md` → "MVP Scoping Principles"]

## Not Doing (and Why)
- [thing] — [reason]

## Open Questions
- [what must be answered before building]
```

**"Not Doing" is the section that earns the document.** Anyone can list what to
build; the trade-offs only become real when the good ideas being dropped are
named alongside their reasons.

Offer to save it to `docs/ideas/[idea-name].md`, on an explicit yes only
(`using-agent-skills` → Ask Before Writing to Disk).

## Verification

- [ ] A "How Might We" problem statement exists, and the target user and
      success criteria were answered before variations were generated
- [ ] 5–8 variations were explored through distinct lenses, each with a reason
      to exist — not 20 shallow ones, and not just the first idea
- [ ] In a codebase, the variations cite what already exists
- [ ] Each direction carries its hidden assumptions and what would kill it
- [ ] The one-pager exists as a file or a message, with a "Not Doing" list
- [ ] Weak ideas were named as weak
- [ ] Nothing was saved to disk without the user's explicit yes
- [ ] On a `ROUTE:` line from `plan-router`, the route's next skill was invoked — or the divergence was declared with an amended route
