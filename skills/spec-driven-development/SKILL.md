---
name: spec-driven-development
description: Writes the spec that a build is judged against, before any code exists. Use when starting a feature or project with no written requirements, when what "done" means is still ambiguous, or when a change spans several modules or settles an architectural decision.
---

# Spec-Driven Development

A spec is the shared source of truth between you and the human: what is being
built, why, and how anyone will know it is done. Code written without one is a
guess whose wrongness surfaces at review instead of at the cheapest moment.

Also write one when the change spans several modules or touches an
architectural decision. Skip it for single-line fixes and changes whose
requirements are unambiguous and self-contained — those need acceptance
criteria, not a document.

## The gate

```
SPECIFY ──→ PLAN ──→ TASKS ──→ IMPLEMENT
```

Each arrow is a human review, and none of them is advisory: a plan built on an
unvalidated spec inherits every misunderstanding in it. This skill owns
SPECIFY. The three that follow have their own owners —
`planning-and-task-breakdown` for PLAN and TASKS,
`incremental-implementation` with `test-driven-development` for IMPLEMENT — and
`context-engineering` for loading the right spec section at each step rather
than the whole document.

## Specify

**Surface your assumptions before writing a line of it**
(`using-agent-skills` → Surface Assumptions). The spec exists to catch
misunderstandings before code does, and an unstated assumption is the form
those take. Then ask clarifying questions until the requirements are concrete —
when the ask is underspecified enough that you'd be guessing, `interview-me`
is the tool for extracting it; when the missing information lives in the code
rather than the human, `codebase-exploration` gathers it. `plan-router` owns
that dispatch.

Six areas, each of which leaks into every downstream task when missing:

1. **Objective** — what is being built, for whom, and what success looks like.
2. **Commands** — full executable commands with flags (`npm test -- --coverage`),
   not tool names.
3. **Project structure** — where source, tests, and docs live.
4. **Code style** — one real snippet in the project's style, plus the naming
   and formatting rules it demonstrates. The snippet does the work; the prose
   describes it.
5. **Testing strategy** — framework, test locations, which level covers which
   concern, coverage expectations.
6. **Boundaries** — three tiers: **always do** (run tests before commits,
   validate inputs), **ask first** (schema changes, new dependencies, CI
   config), **never do** (commit secrets, edit vendored code, delete failing
   tests).

```markdown
# Spec: [Name]

## Objective
## Tech Stack
## Commands
## Project Structure
## Code Style
## Testing Strategy
## Boundaries
- Always / Ask first / Never
## Success Criteria
## Open Questions
```

## Turn vague requirements into success criteria

A requirement you cannot test is a requirement you cannot finish. Translate it,
then confirm the translation before building against it:

```
REQUIREMENT: "Make the dashboard faster"

SUCCESS CRITERIA:
- Dashboard LCP < 2.5s on 4G
- Initial data load < 500ms
- No layout shift during load (CLS < 0.1)
→ Are these the right targets?
```

The numbers may be wrong, and that is the point: a wrong number gets corrected
in one message, where "faster" gets built wrong and corrected in a rebuild.
Anything still unresolved goes in **Open Questions** rather than being decided
silently — inventing a requirement is the human's call, not yours.

## Keep it alive

The spec is version-controlled alongside the code, updated **before** the
implementation when a decision or a scope changes, and linked from the PR that
implements each section. A spec updated after the fact is documentation; its
value was in constraining the code that already got written.

## Verification

- [ ] All six areas are covered, and Code Style carries a real snippet
- [ ] Every success criterion is specific and testable
- [ ] Boundaries name always / ask-first / never
- [ ] Assumptions were stated and corrected before the spec was written
- [ ] Anything undecided sits in Open Questions rather than being invented
- [ ] The human has reviewed the spec, and it is committed to the repository
- [ ] On a `ROUTE:` line from `plan-router`, the route's next skill was invoked — or the divergence was declared with an amended route
