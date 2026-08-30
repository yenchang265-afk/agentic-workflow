---
name: test-driven-development
description: Drives development with a failing test first; bugs get a reproduction test before any fix. Use when implementing or changing behavior, fixing a bug, or adding tests to code that already exists.
---

# Test-Driven Development

Write a failing test before the code that makes it pass. Tests are **proof**
(`using-agent-skills` → Verify, Don't Assume).

Pure configuration, documentation, and static-content changes have no behavior
to prove; skip them. For browser-based changes, pair this skill with
`browser-testing-with-devtools` for runtime verification.

## The cycle

**RED** — write the test first and run it. It must fail, and fail for the reason
you expect. A test that passes immediately proves nothing.

**GREEN** — write the minimum code to pass. No extra cases, no speculative
abstraction.

**REFACTOR** — improve naming, extract shared logic, remove duplication, with
tests green. Re-run the tests after every refactor step.

Repeat per behavior.

**Done when** every acceptance criterion has a test that failed before the
implementation existed and passes after it.

## Prove-It (bug fixes)

A bug report is a test request before it is a fix request: reproduce it in a
test that fails for the reported reason, fix it, watch that test pass, then run
the full suite for regressions.

A fix without a failing-first reproduction is a guess — you cannot tell a bug
you fixed from a bug you failed to trigger.

## What to write

**The Beyonce Rule:** if you liked it, you should have put a test on it.
Infrastructure changes, refactors, and migrations are not responsible for
catching your bugs — your tests are.

Classify every test by the resources it consumes, and keep the suite
bottom-heavy: the vast majority small, because small tests are fast, reliable,
and easy to debug when they fail.

| Size | Constraints | Speed | Reach for it when |
|------|------------|-------|-------------------|
| **Small** | Single process, no I/O, network, or database | Milliseconds | The behavior is pure logic with no side effects |
| **Medium** | Multi-process OK, localhost only, no external services | Seconds | The behavior crosses a boundary — API, database, file system |
| **Large** | Multi-machine OK, external services allowed | Minutes | A critical user flow must work end-to-end; limit these to critical paths |

Component tests address the accessibility tree rather than test ids, which is
what keeps them from re-breaking on markup changes.

Rules for each test:

- **Test state, not interactions.** Assert on the outcome of an operation, never
  on which methods were called — interaction tests break under refactor even
  when behavior is unchanged.
- **DAMP over DRY.** A test reads like a specification: self-contained and
  descriptive, with duplication acceptable when it keeps each test
  independently understandable.
- **Prefer real implementations** — then fakes, then stubs, then mocks
  (sparingly). Mock only at boundaries where the real dependency is slow,
  non-deterministic, or side-effectful.
- **One assertion-concept per test**, named for the behavior it verifies ("sets
  completedAt when task is completed" — never "works").
- **Deterministic and isolated.** A test that depends on wall-clock timing, on
  another test's leftover state, or on run order is a flake, and a flaky suite
  stops being read at all. A test that cannot be made deterministic is deleted,
  never skipped into permanence.

## Verification

- [ ] Every new behavior has a test that failed before the implementation existed
- [ ] Every bug fix has a reproduction test that failed before the fix
- [ ] Test names describe the behavior verified, not the function called
- [ ] The full suite passes with no test skipped, disabled, or weakened to get there
- [ ] Coverage hasn't decreased (if tracked)

One clean run per code state — see `references/definition-of-done.md` →
Verification Discipline.
