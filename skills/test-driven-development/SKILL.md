---
name: test-driven-development
description: Drives development with a failing test first; bugs get a reproduction test before any fix. Use when implementing behavior, fixing a bug, or modifying existing functionality.
---

# Test-Driven Development

Write a failing test before the code that makes it pass. Tests are **proof** —
"seems right" is not done.

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

Repeat per behavior. Worked RED→GREEN example:
`references/testing-patterns.md` → The RED/GREEN Cycle.

**Done when** every acceptance criterion has a test that failed before the
implementation existed and passes after it.

## Prove-It (bug fixes)

A bug report is a test request before it is a fix request. **Do not start by
trying to fix it.**

```
Bug report arrives
       │
       ▼
  Write a test that demonstrates the bug
       │
       ▼
  Test FAILS (confirming the bug exists — and that you understood it)
       │
       ▼
  Implement the fix
       │
       ▼
  Test PASSES (proving the fix works)
       │
       ▼
  Run full test suite (no regressions)
```

A fix without a failing-first reproduction is a guess: you cannot tell a bug you
fixed from a bug you failed to trigger. Worked example:
`references/testing-patterns.md` → The Prove-It Pattern.

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

Rules for each test, with worked examples in `references/testing-patterns.md`:

- **Test state, not interactions.** Assert on the outcome of an operation, never
  on which methods were called — interaction tests break under refactor even
  when behavior is unchanged.
- **DAMP over DRY.** A test reads like a specification: self-contained and
  descriptive, with duplication acceptable when it keeps each test
  independently understandable.
- **Prefer real implementations** — then fakes, then stubs, then mocks
  (sparingly). Mock only at boundaries where the real dependency is slow,
  non-deterministic, or side-effectful.
- **Arrange-Act-Assert** structure in every test.
- **One assertion-concept per test**, named for the behavior it verifies ("sets
  completedAt when task is completed" — never "works").

Flaky tests, snapshot abuse, over-mocking, and shared state are catalogued in
`references/testing-patterns.md` → Test Anti-Patterns.

## Verification

- [ ] Every new behavior has a test that failed before the implementation existed
- [ ] Every bug fix has a reproduction test that failed before the fix
- [ ] Test names describe the behavior verified, not the function called
- [ ] The full suite passes with no test skipped, disabled, or weakened to get there
- [ ] Coverage hasn't decreased (if tracked)

One clean run per code state — see `references/definition-of-done.md` →
Verification Discipline.
