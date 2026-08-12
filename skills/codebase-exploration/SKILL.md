---
name: codebase-exploration
description: Investigates the code behind a symptom or open question and ranks 2-3 options against what is actually there — no artifact owed, cheap to abandon. Use when a complaint names a symptom but not a cause, when a choice between approaches must be judged against the real code, or when holding a problem in unfamiliar code with no plan yet.
---

# Codebase Exploration

You are a thinking partner holding a **problem**, not a plan. The user brings a
symptom, an open question, or a fork in the road; you bring what the code
actually does. Exploring commits nobody to anything: ending with "this isn't
worth doing" is a legal outcome, and the conversation itself is the
deliverable — write nothing to disk unless asked.

**Boundary:** a failure you can reproduce belongs to
`debugging-and-error-recovery` — it owns triage and repair, at any point it
emerges. This skill takes the earlier moment: something feels off, nothing is
red yet, or the question is "which way should we build this?" rather than
"why is this broken?".

## The Process

### 1. Read before you speak

`Glob`/`Grep`/`Read` the real code: trace the actual path behind the symptom
or question — entry point, data flow, the code that runs when the complained-of
behavior happens. Prior art counts: an existing helper, a half-finished
attempt, a config flag that already does part of the job.

**Done when** you can cite the mechanism as `file:line` without guessing.
"Probably somewhere in the scheduler" means keep reading.

### 2. Name the root cause or the real question

Restate the symptom as a mechanism, citing files — "the hub polls
`flushMetrics` on every render, and each poll re-reads the whole run log" —
or restate the open question as the concrete decision the code forces. A
symptom explained by how codebases usually work, rather than by this one, is
step 1 unfinished.

**Done when** the user recognizes their problem in your restatement.

### 3. Rank 2-3 options against the real code

For each option: what it touches (files), roughly what it costs, its main
risk, and the trade-off it makes. Then recommend one, with the reasoning.
Two options that differ only in naming are one option — make them genuinely
different shapes.

**Done when** every option cites the code it would change, and one carries
your recommendation.

### 4. Hand off — or bail

Three legal exits, and the user picks:

- **Multi-module or architectural** → `spec-driven-development` writes the
  chosen direction down; the exploration context seeds the spec.
- **One scoped change** → `planning-and-task-breakdown` branch B plans it
  directly.
- **Not worth doing, or not yet** → stop here. Nothing was written, so
  nothing needs cleaning up.

On a `ROUTE:` line from `plan-router`, the exit is already encoded: invoke
the route's next skill, or declare which conditional exit fired and follow
the amended route.

**Done when** the exit is stated explicitly — including the bail — and the
successor skill is invoked (a bail ends the route; nothing follows).

## Facts and decisions

A genuine **decision** surfaced mid-exploration (two options survive contact
with the code and the trade-off is the user's to make) goes to the user;
several of them at once means `interview-me` takes over with your discovered
facts as its `GUESS:` lines.

## Interaction with Other Skills

- **`plan-router`** — upstream dispatcher: routes here when the missing
  information lives in the codebase.
- **`doubt-driven-development`** — post-decision cross-examination; this skill
  is pre-decision. A draft or decision in hand means doubt, a problem in hand
  means explore.
- **`source-driven-development`** — facts about a library's API need doc
  citations, not just a read of the call site.
- **`documentation-and-adrs`** — a hard-to-reverse choice made off the back of
  an exploration deserves an ADR.

## Verification

- [ ] The mechanism behind the symptom or question is cited as `file:line`
- [ ] The restatement names a mechanism in this codebase, not a generic cause
- [ ] 2-3 genuinely different options exist, each citing the code it would touch
- [ ] One option carries a recommendation with its reasoning
- [ ] Decisions surfaced along the way went to the user, not into assumptions
- [ ] Nothing was written to disk without the user asking
- [ ] The exit — spec, plan, or bail — was stated explicitly, and the route's successor skill was invoked (a bail ends the route)
