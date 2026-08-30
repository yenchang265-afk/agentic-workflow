# Migration Rollout

Executing a deprecation once `deprecation-and-migration` has decided it —
whether to deprecate at all, advisory or compulsory, and which pattern. This is
the process that follows, and it spans far more than one change: run it a phase
at a time.

## 1. Build the replacement first

No deprecation without a working alternative: it covers the critical use cases,
it has a migration guide, and it is proven in production rather than in
principle. A deprecation announced ahead of its replacement converts every
consumer's plan into waiting.

## 2. Announce it where the consumer already is

The notice names the status and date, the replacement, the reason in terms of
what the consumer gets, and the concrete first migration step. A **compulsory**
deprecation adds a removal date *and* the tooling that makes that date
achievable — a codemod, a script, a verification command. An advisory one leaves
the date open and says so, rather than implying one.

## 3. Migrate consumers one at a time

Per consumer: find every touchpoint, move it, prove behaviour matches, drop the
old references. Under the Churn Rule this is the deprecating team's work, not
the consumers' — the team that benefits from the change pays for it.

Where a strangler pattern replaces the per-consumer loop, the traffic ladder is
the unit instead: 0% → canary → half → all → old system idle, with a rollback at
every rung and the old system left running until the last one holds.

## 4. Remove only against evidence

Zero usage is proven from metrics, logs, and dependency analysis — never
expected. Hyrum's Law says the consumer you did not know about is the one that
breaks. Then remove the code, its tests, its configuration, *and* the
deprecation notices: a notice outliving the thing it deprecated is how the next
reader learns to distrust every other notice.

## Verification

- [ ] Replacement is production-proven and covers all critical use cases
- [ ] Migration guide exists with concrete steps and examples
- [ ] Every active consumer has migrated, evidenced by metrics or logs showing zero usage
- [ ] Old code, tests, documentation, and configuration are removed
- [ ] No references to the deprecated system remain in the codebase
- [ ] Deprecation notices are removed — they served their purpose
