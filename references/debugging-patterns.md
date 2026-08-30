# Debugging Patterns

The tactics behind `debugging-and-error-recovery` that a read of the code does
not supply on its own. Each section names the step it serves.

## Reproduce — a failure that will not reproduce on demand (step 1)

Every one of these sits on one of three axes, and naming the axis is the triage
result:

- **Timing** — widen the window rather than staring at it: timestamps around the
  suspect region, an artificial delay inside it, and the scenario re-run under
  concurrency or load so collisions get likelier.
- **State** — run the failing scenario in isolation, then after the operations
  that precede it in a real run. A difference between those two is leaked state:
  a global, a singleton, a shared cache, an unreset fixture.
- **Environment** — diff the runtime, the OS, the environment variables, and the
  *data* (an empty database against a populated one) against where it passes; CI
  is the cleanest environment available to compare with.

"Flaky" names the observation, not the cause. It is something to report as a
triage result, never a reason to move on.

## Localize (step 2)

For a regression — something that demonstrably worked before — bisect rather
than reading forward from the symptom. It costs one scripted run and returns the
commit itself:

```bash
git bisect start && git bisect bad && git bisect good <known-good-sha>
git bisect run <command that exits non-zero on the bug>
```

When a test fails after a change to code it does not cover, the suspicion is a
side effect through shared state, an import, or a global — not the test.

## Instrumentation — what to add, remove, and keep (steps 2 and 5)

**Add** when reading the code cannot localize the failure to a line, when the
issue is intermittent and needs watching, or when several components interact.

**Remove** once a test guards the fix — and immediately, without waiting for the
fix, if it prints sensitive data.

**Keep** only what has a production reader: error boundaries that report, API
error logs carrying request context, metrics on key flows. Anything shipped to
production belongs to `observability-and-instrumentation`; this section is what
you add to find one bug.

## Prove it — the failing test (step 4)

The Prove-It cycle lives in `test-driven-development`. What the debugging branch
adds: the test asserts the mechanism the report named, not the area around it, so
a fix elsewhere cannot turn it green.

## Safe fallbacks — when the root fix has to wait (step 5)

A fallback keeps the surface usable while the cause stays open: a defaulted
config with a warning, an empty state, a caught render error. It is a second
change stacked on the report, never a substitute for it — the report stays open,
and the fallback's own warning is what tells you the cause is still live.
