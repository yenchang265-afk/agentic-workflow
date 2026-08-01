---
name: documentation-and-adrs
description: Records the why behind a decision, in the form that outlives the code — chiefly the ADR. Use when making an architectural decision, changing a public API, or shipping behavior a future engineer has to understand.
---

# Documentation and ADRs

Code shows *what* was built. It cannot show why this way, what was rejected, or
which constraint forced the shape — and that is exactly the part no future
reader can recover from the source. It is also the part that does not go stale:
the **why** stays true while the *what* changes with every edit. Document the
why, and only the why.

The Architecture Decision Record is the highest-value form of it and most of
this skill. READMEs, changelogs, JSDoc, and OpenAPI mechanics are in
`references/documentation-patterns.md`.

## When a decision earns an ADR

**The test is reversibility, not size.** A one-line config change that pins the
project to a vendor earns one; a thousand-line refactor that could be undone
tomorrow does not. In practice that means framework and major-dependency
choices, data models and schemas, authentication strategy, API architecture,
and build/hosting/infrastructure commitments.

## The record

Sequentially numbered, in `docs/decisions/`:

```markdown
# ADR-001: Use PostgreSQL for the primary database

## Status
Accepted | Superseded by ADR-XXX | Deprecated

## Date
2025-01-15

## Context
Requirements that constrained the choice: relational data (users, tasks, teams),
ACID transactions on task state, full-text search over task content, managed
hosting (small team, limited ops capacity).

## Decision
PostgreSQL with Prisma.

## Alternatives Considered
### MongoDB
Flexible schema, easy start — but the data is inherently relational, so
relationships end up managed by hand. Rejected: complex joins or duplication.
### SQLite
Zero config, fast reads — but limited concurrent writes and no managed
production hosting. Rejected: multi-user web application.
### MySQL
Mature and widely supported — but PostgreSQL has the better JSON support,
full-text search, and tooling for these requirements. Rejected on fit.

## Consequences
Type-safe access and migrations via Prisma. Full-text search without adding
Elasticsearch. The team takes on PostgreSQL knowledge (standard, low risk) and
a managed host.
```

**Alternatives Considered is the section that earns the record.** Without it,
the ADR says what was chosen but not what was ruled out, so the next engineer
re-opens the question you already closed — and re-opens it without the
constraints you had.

**Consequences are what the project now carries** as a result, including the
costs. An ADR listing only benefits is a pitch, not a record.

## The lifecycle is append-only

```
PROPOSED → ACCEPTED → (SUPERSEDED | DEPRECATED)
```

When a decision changes, write a new ADR that names and supersedes the old one,
and leave the old one in place. Editing it in place destroys the explanation
for why the codebase currently looks the way it does — the superseded record is
the context for every line still written against it.

## Inline: why and gotchas only

```typescript
// Restates the code — no
// Increment counter by 1
counter += 1;

// Non-obvious intent — yes
// Sliding window: reset at the boundary rather than on a fixed schedule,
// so bursts at the window edge can't double the allowance
if (now - windowStart > WINDOW_SIZE_MS) {
  counter = 0;
  windowStart = now;
}
```

The other comment worth writing is the **gotcha** — the trap a reader would
otherwise fall into — anchored to the line that has it. Agents read these too,
alongside the rules file, the spec, and the ADRs, and stop re-deciding settled
questions because of them. More forms and examples:
`references/documentation-patterns.md`.

Commented-out code is not documentation. Delete it; git remembers.

## Verification

**When a decision has been made:**

- [ ] Whether it needs an ADR is stated, decided by reversibility
- [ ] If one is needed, its number and title are named, along with any ADR it
      supersedes

**When an ADR has been written:**

- [ ] Context states the requirements that constrained the choice
- [ ] Alternatives Considered names each rejected option and why it lost
- [ ] Consequences state what the project takes on, costs included
- [ ] Status is set, and a superseded predecessor is left intact and linked

**When code has been written:**

- [ ] Every comment explains why or flags a gotcha; none restates the line
      below it
