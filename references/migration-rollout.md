# Migration Rollout

Executing a deprecation once it has been decided. Reached from `deprecation-and-migration`, which owns the decision — whether to deprecate, advisory or compulsory, and which migration pattern. This file is the process that follows, and it spans far more than one change: run it a phase at a time.

## Step 1: Build the Replacement

Do not deprecate without a working alternative. The replacement must:

- Cover all critical use cases of the old system
- Have documentation and a migration guide
- Be proven in production, not just theoretically better

## Step 2: Announce and Document

```markdown
## Deprecation Notice: OldService

**Status:** Deprecated as of 2025-03-01
**Replacement:** NewService (see migration guide below)
**Removal date:** Advisory — no hard deadline yet
**Reason:** OldService requires manual scaling and lacks observability.
            NewService handles both automatically.

### Migration Guide
1. Replace `import { client } from 'old-service'` with `import { client } from 'new-service'`
2. Update configuration (see examples below)
3. Run the migration verification script: `npx migrate-check`
```

A compulsory deprecation adds a removal date and the tooling that makes it achievable. An advisory one leaves the date open.

## Step 3: Migrate Consumers Incrementally

One consumer at a time, never all at once. For each:

```
1. Identify all touchpoints with the deprecated system
2. Update to use the replacement
3. Verify behavior matches (tests, integration checks)
4. Remove references to the old system
5. Confirm no regressions
```

Under the Churn Rule, this is the deprecating team's work, not the consumers'.

For a strangler rollout, the traffic ladder replaces the per-consumer loop:

```
Phase 1: New system handles 0%, old handles 100%
Phase 2: New system handles 10% (canary)
Phase 3: New system handles 50%
Phase 4: New system handles 100%, old system idle
Phase 5: Remove old system
```

## Step 4: Remove the Old System

Only once every consumer has moved:

```
1. Verify zero active usage (metrics, logs, dependency analysis)
2. Remove the code
3. Remove associated tests, documentation, and configuration
4. Remove the deprecation notices
```

Zero usage is proven by evidence, not by expectation — Hyrum's Law means the consumer you did not know about is the one that breaks.

## Verification

After a rollout completes:

- [ ] Replacement is production-proven and covers all critical use cases
- [ ] Migration guide exists with concrete steps and examples
- [ ] Every active consumer has migrated, evidenced by metrics or logs showing zero usage
- [ ] Old code, tests, documentation, and configuration are removed
- [ ] No references to the deprecated system remain in the codebase
- [ ] Deprecation notices are removed — they served their purpose
