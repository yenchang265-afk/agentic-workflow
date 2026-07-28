---
name: deprecation-and-migration
description: Sunsets old systems and migrates their users safely. Use when removing an API, feature, or system, or deciding whether to maintain or retire existing code.
---

# Deprecation and Migration

## Overview

Code is a liability, not an asset. Deprecation is the discipline of removing code that no longer earns its keep; migration is moving users safely from the old to the new. Most engineering organizations are good at building things and few are good at removing them — this skill addresses that gap.

Two things happen here, and they happen at different times. **Deciding** to deprecate is a design call, made before anything moves. **Rolling out** the migration is a long-running process that outlives any single change. This file owns the decision; `references/migration-rollout.md` owns the rollout.

## When to Use

- Replacing an old system, API, or library with a new one
- Sunsetting a feature, or consolidating duplicate implementations
- Removing code that nobody owns but everybody depends on
- Deciding whether to maintain a legacy system or invest in migration
- Designing something new (deprecation planning starts at design time)

## Core Principles

### Code Is a Liability

Every line has ongoing cost: tests, documentation, security patches, dependency updates, and mental overhead for anyone working nearby. The value is the functionality, not the code. When the same functionality can be provided with less code or a better abstraction, the old code should go.

### Hyrum's Law Makes Removal Hard

With enough users, every observable behavior becomes depended on — including bugs, timing quirks, and undocumented side effects. This is why deprecation requires active migration rather than announcement. Users cannot "just switch" when they depend on behaviors the replacement does not replicate.

### Deprecation Planning Starts at Design Time

When building something new, ask: "how would we remove this in three years?" Systems with clean interfaces, feature flags, and small surface area are cheap to deprecate. Systems that leak implementation details everywhere are not — see `api-and-interface-design`.

### The Churn Rule

If you own the infrastructure being deprecated, you own migrating its users — or you ship a backward-compatible change that requires no migration. Announcing a deprecation and leaving consumers to work it out is how zombie code is made.

## The Deprecation Decision

Answer all five before anything moves:

```
1. Does this system still provide unique value?
   → If yes, maintain it. If no, proceed.

2. How many users/consumers depend on it?
   → Quantify the migration scope.

3. Does a replacement exist?
   → If no, build the replacement first. Don't deprecate without an alternative.

4. What's the migration cost for each consumer?
   → If trivially automated, do it. If manual and high-effort, weigh against maintenance cost.

5. What's the ongoing maintenance cost of NOT deprecating?
   → Security risk, engineer time, opportunity cost of complexity.
```

### Compulsory vs Advisory

| Type | When to Use | Mechanism |
|------|-------------|-----------|
| **Advisory** | Migration is optional, old system is stable | Warnings, documentation, nudges. Users migrate on their own timeline. |
| **Compulsory** | Old system has security issues, blocks progress, or maintenance cost is unsustainable | Hard deadline plus migration tooling, documentation, and support |

**Default to advisory.** Compulsory deprecation is a commitment to provide tooling and support, not just a date.

## Choosing a Migration Pattern

Name the pattern as part of the decision — it determines what the work is:

| Pattern | Use when | Shape |
|---|---|---|
| **Strangler** | The old system serves live traffic and cannot go dark | Run both, route traffic old → new incrementally (0% → canary → 50% → 100%), then remove the old |
| **Adapter** | Consumers are many and their call sites are expensive to change | Keep the old interface, reimplement it over the new system, migrate the backend first |
| **Feature flag** | Consumers can be switched individually and switched back | Flag selects the implementation per user or per call site; the flag's removal is the last step |

```typescript
// Adapter: old interface, new implementation
class LegacyTaskService implements OldTaskAPI {
  constructor(private newService: NewTaskService) {}

  getTask(id: number): OldTask {
    const task = this.newService.findById(String(id));
    return this.toOldFormat(task);
  }
}
```

## Scoping a Deprecation Into Work

A deprecation rarely fits in one change. Once the pattern is chosen, say which **phase** the current work lands — build the replacement, add the adapter, move one consumer, flip the default, delete the old code — and treat the remaining phases as separate work rather than scope creep.

> **In the agentic loop:** those phases are sibling draft tasks, ordered and approved one at a time. See `task-backlog-management` → "Slicing a heavy idea". Attempting a whole deprecation in one task produces a change no human can review in one sitting.

The full rollout — announcing, migrating consumers one at a time, proving zero usage, and removing the old system — is in `references/migration-rollout.md`. Reach for it when executing a phase, not when deciding one.

## Zombie Code

Zombie code is code nobody owns but everybody depends on. Signs:

- No commits in 6+ months but active consumers exist
- No assigned maintainer or team
- Failing tests that nobody fixes
- Dependencies with known vulnerabilities that nobody updates

**Response:** assign an owner and maintain it properly, or deprecate it with a concrete migration plan. Zombie code cannot stay in limbo — it gets investment or removal.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Someone might need it later" | If it's needed later, it can be rebuilt from git history. Keeping unused code costs more than rebuilding. |
| "Users will migrate on their own" | They won't. The Churn Rule: provide tooling and documentation, or do the migration yourself. |

## Red Flags

- A deprecation announced with no replacement available
- New features added to a deprecated system
- Zombie code with no owner and active consumers

## Verification

**When the deprecation has been decided** (before anything moves):

- [ ] All five decision questions are answered, with the consumer count quantified
- [ ] A replacement exists or is the first phase of the work
- [ ] Advisory or compulsory is chosen, and compulsory carries tooling and a deadline
- [ ] A migration pattern is named
- [ ] The current phase is stated, and the remaining phases are captured as separate work

**When a phase has been executed:** see `references/migration-rollout.md`.
