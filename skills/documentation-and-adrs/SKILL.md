---
name: documentation-and-adrs
description: Records the why behind decisions. Use when making an architectural decision, changing a public API, or shipping behavior future engineers must understand.
---

# Documentation and ADRs

## Overview

Document decisions, not just code. Code shows *what* was built; documentation explains *why it was built this way* and *what alternatives were rejected*. That context is what future humans and agents cannot recover from the source, and it is the only documentation that does not go stale — the **why** is stable, the **what** changes with every edit.

An Architecture Decision Record is the highest-value form of it, and the one this skill is mostly about. The mechanics of the other forms — READMEs, changelogs, inline comments, API docs — are in `references/documentation-patterns.md`.

## When to Use

- Making a significant architectural decision, or choosing between competing approaches
- Adding or changing a public API
- Shipping a feature that changes user-facing behavior
- When you find yourself explaining the same thing repeatedly

**When NOT to use:** obvious code, or throwaway prototypes.

## When a Decision Earns an ADR

Write one when the decision would be expensive to reverse:

- Choosing a framework, library, or major dependency
- Designing a data model or database schema
- Selecting an authentication strategy
- Deciding on an API architecture (REST vs. GraphQL vs. tRPC)
- Choosing between build tools, hosting platforms, or infrastructure

The test is reversibility, not size. A one-line config change that pins the whole project to a vendor earns an ADR; a large refactor that could be undone tomorrow does not.

## ADR Template

Store ADRs in `docs/decisions/` with sequential numbering:

```markdown
# ADR-001: Use PostgreSQL for primary database

## Status
Accepted | Superseded by ADR-XXX | Deprecated

## Date
2025-01-15

## Context
We need a primary database for the task management application. Key requirements:
- Relational data model (users, tasks, teams with relationships)
- ACID transactions for task state changes
- Support for full-text search on task content
- Managed hosting available (for small team, limited ops capacity)

## Decision
Use PostgreSQL with Prisma ORM.

## Alternatives Considered

### MongoDB
- Pros: Flexible schema, easy to start with
- Cons: Our data is inherently relational; would need to manage relationships manually
- Rejected: Relational data in a document store leads to complex joins or data duplication

### SQLite
- Pros: Zero configuration, embedded, fast for reads
- Cons: Limited concurrent write support, no managed hosting for production
- Rejected: Not suitable for multi-user web application in production

### MySQL
- Pros: Mature, widely supported
- Cons: PostgreSQL has better JSON support, full-text search, and ecosystem tooling
- Rejected: PostgreSQL is the better fit for our feature requirements

## Consequences
- Prisma provides type-safe database access and migration management
- We can use PostgreSQL's full-text search instead of adding Elasticsearch
- Team needs PostgreSQL knowledge (standard skill, low risk)
- Hosting on managed service (Supabase, Neon, or RDS)
```

**Alternatives Considered is the section that earns the ADR.** Without it the record explains what was chosen but not what was ruled out, so the next engineer re-opens the same question.

## ADR Lifecycle

```
PROPOSED → ACCEPTED → (SUPERSEDED or DEPRECATED)
```

An ADR is append-only history: when a decision changes, write a new ADR that references and supersedes the old one, and leave the old one in place. Deleting it destroys the context that explains why the codebase looks the way it does.

## Inline Documentation

Comment the *why*, never the *what* — the what is already in the line below the comment, and it is the half that goes stale.

```typescript
// Restates the code — no
// Increment counter by 1
counter += 1;

// Explains non-obvious intent — yes
// Rate limit uses a sliding window — reset counter at window boundary,
// not on a fixed schedule, to prevent burst attacks at window edges
if (now - windowStart > WINDOW_SIZE_MS) {
  counter = 0;
  windowStart = now;
}
```

Known gotchas — the traps a reader would otherwise fall into — are the other thing worth an inline comment, anchored to the code that has the trap. Examples, plus README, changelog, JSDoc and OpenAPI forms, are in `references/documentation-patterns.md`.

## Documentation for Agents

Agents read the same artifacts and one more:

- **CLAUDE.md / rules files** — project conventions, so agents follow them
- **Spec files** — kept current, so agents build the right thing
- **ADRs** — so agents understand why past decisions were made and stop re-deciding them
- **Inline gotchas** — so agents do not fall into known traps

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The code is self-documenting" | Code shows what. It doesn't show why, what alternatives were rejected, or what constraints apply. |
| "Comments get outdated" | Comments on *why* are stable. Comments on *what* get outdated — which is why you only write the former. |

## Red Flags

- Documentation that restates the code instead of explaining intent
- An ADR with no Alternatives Considered section
- A superseded decision edited in place instead of recorded as a new ADR
- Commented-out code left in place of deletion

## Verification

**When a decision has been made** (before or during planning):

- [ ] Whether the decision needs an ADR is stated, and the reversibility test is what decided it
- [ ] If one is needed, its number and title are named
- [ ] Any ADR it supersedes is identified

**When an ADR has been written:**

- [ ] Context states the requirements that constrained the choice
- [ ] Alternatives Considered lists each rejected option with its reason
- [ ] Consequences state what the project now takes on
- [ ] Status is set, and a superseded predecessor links forward

**When code has been written:** see `references/documentation-patterns.md`.
