---
name: deprecation-and-migration
description: Decides whether to retire a system and how its users get moved — the decision, the pattern, and the phase this change lands. Use when removing an API, feature, or system, weighing maintaining legacy code against replacing it, or moving consumers onto a replacement.
---

# Deprecation and Migration

Code is a liability, not an asset. Every line carries ongoing cost — tests,
docs, security patches, dependency bumps, and the attention of everyone working
near it. The value was always the functionality; when the same functionality
needs less code, the old code should go.

Two things happen here at different times. **Deciding** to deprecate is a
design call made before anything moves, and this file owns it. **Rolling out**
the migration outlives any single change, and lives in
`references/migration-rollout.md`.

## Why removal is hard

**Hyrum's Law.** With enough users, every observable behavior is depended on —
including bugs, timing quirks, and undocumented side effects. Users cannot
"just switch" when the replacement fails to reproduce behaviors they never told
you they relied on. This is why deprecation is an active migration rather than
an announcement.

**The churn rule.** If you own the infrastructure being deprecated, you own
moving its users — or you ship a backward-compatible change requiring no
migration at all. Announcing a deprecation and leaving consumers to work it out
is how zombie code gets made.

**Removal cost is set at design time.** Building something new, ask how it
would be removed in three years. Clean interfaces, feature flags, and a small
surface area are cheap to retire; implementation details leaking everywhere are
not — `api-and-interface-design`.

## The decision

Answer all five before anything moves:

1. **Does it still provide unique value?** If yes, maintain it and stop here.
2. **How many consumers depend on it?** A number, not "a few" — it sizes
   everything downstream.
3. **Does a replacement exist?** If not, building it is the first phase.
   Deprecating without an alternative just strands people.
4. **What is the migration cost per consumer?** Trivially automatable means do
   it now; manual and high-effort gets weighed against the maintenance cost.
5. **What does *not* deprecating cost?** Security exposure, engineer time, and
   the complexity tax on everything built nearby.

Then choose the mode. **Advisory** is the default: the old system is stable,
migration is optional, users move on their own timeline behind warnings and
docs. **Compulsory** — a hard deadline — is for security exposure, blocked
progress, or unsustainable maintenance, and it is a commitment to supply the
tooling, documentation, and support that make the deadline meetable. A date
without those is not a plan.

## Name the pattern

The pattern decides what the work actually is:

| Pattern | Use when | Shape |
|---|---|---|
| **Strangler** | the old system serves live traffic and cannot go dark | run both, route old → new incrementally (canary → 50% → 100%), then remove the old |
| **Adapter** | consumers are many and their call sites are expensive to change | keep the old interface, reimplement it over the new system, migrate the backend first |
| **Feature flag** | consumers can be switched, and switched back, one at a time | the flag selects the implementation per user or call site; removing the flag is the last step |

```typescript
// Adapter: old interface, new implementation
class LegacyTaskService implements OldTaskAPI {
  constructor(private newService: NewTaskService) {}

  getTask(id: number): OldTask {
    return this.toOldFormat(this.newService.findById(String(id)));
  }
}
```

## Say which phase this change is

A deprecation does not fit in one change. Once the pattern is chosen, name
which phase the current work lands in:

1. Build the replacement
2. Add the adapter
3. Move one consumer
4. Flip the default
5. Delete the old code

Treat every phase but the current one as separate work, not scope creep.

> **In the agentic loop:** those phases are sibling draft tasks, approved and
> shipped one at a time. See `task-backlog-management` → "Slicing a heavy
> idea". A whole deprecation in one task produces a diff nobody can review in
> one sitting.

Executing a phase — announcing, moving consumers, proving zero usage, deleting
— is `references/migration-rollout.md`.

## Zombie code

Code nobody owns and everybody depends on: no commits in six months but live
consumers, no assigned maintainer, failing tests nobody fixes, known-vulnerable
dependencies nobody updates.

It gets an owner and real maintenance, or a deprecation with a concrete
migration plan. Limbo is the one state it cannot stay in, because the cost
accrues either way and nobody is watching it.

## Verification

**When the deprecation has been decided:**

- [ ] All five questions are answered, with the consumer count quantified
- [ ] A replacement exists, or building it is the first phase
- [ ] Advisory or compulsory is chosen, and compulsory carries tooling and a
      deadline
- [ ] A migration pattern is named
- [ ] The current phase is stated and the remaining phases are captured as
      separate work
- [ ] Nothing new was added to the system being deprecated

**When a phase has been executed:** see `references/migration-rollout.md`.
