# Debugging Patterns

Dissection trees, command recipes, and code patterns backing
`debugging-and-error-recovery`. Reached from a triage step or a repair step —
each section names the step it serves.

## Triage

### Reproduce — dissecting a failure that will not reproduce (step 1)

```
Cannot reproduce on demand:
├── Timing-dependent?
│   ├── Add timestamps to logs around the suspected area
│   ├── Try with artificial delays (setTimeout, sleep) to widen race windows
│   └── Run under load or concurrency to increase collision probability
├── Environment-dependent?
│   ├── Compare Node/browser versions, OS, environment variables
│   ├── Check for differences in data (empty vs populated database)
│   └── Try reproducing in CI where the environment is clean
├── State-dependent?
│   ├── Check for leaked state between tests or requests
│   ├── Look for global variables, singletons, or shared caches
│   └── Run the failing scenario in isolation vs after other operations
└── Truly random?
    ├── Add defensive logging at the suspected location
    ├── Set up an alert for the specific error signature
    └── Document the conditions observed and revisit when it recurs
```

A test that only fails sometimes is on one of these axes — timing, state, or
environment. "Flaky" names the observation, not the cause, so it is a triage
result to report, never a reason to move on.

Running one test in isolation separates a real failure from test pollution:

```bash
# Run the specific failing test
npm test -- --grep "test name"

# Run with verbose output
npm test -- --verbose

# Run in isolation (rules out test pollution)
npm test -- --testPathPattern="specific-file" --runInBand
```

### Localize — which layer is failing (step 2)

```
Which layer is failing?
├── UI/Frontend     → Check console, DOM, network tab
├── API/Backend     → Check server logs, request/response
├── Database        → Check queries, schema, data integrity
├── Build tooling   → Check config, dependencies, environment
├── External service → Check connectivity, API changes, rate limits
└── Test itself     → Check if the test is correct (false negative)
```

For a regression — something that worked before — bisect to the commit instead
of reading forward from the symptom:

```bash
# Find which commit introduced the bug
git bisect start
git bisect bad                    # Current commit is broken
git bisect good <known-good-sha>  # This commit worked
# Git will checkout midpoint commits; run your test at each
git bisect run npm test -- --grep "failing test"
```

### Localize — error-specific triage (step 2)

```
Test fails after code change:
├── Did you change code the test covers?
│   └── YES → Check if the test or the code is wrong
│       ├── Test is outdated → Update the test
│       └── Code has a bug → Fix the code
├── Did you change unrelated code?
│   └── YES → Likely a side effect → Check shared state, imports, globals
└── Test was already flaky?
    └── Check for timing issues, order dependence, external dependencies
```

```
Build fails:
├── Type error → Read the error, check the types at the cited location
├── Import error → Check the module exists, exports match, paths are correct
├── Config error → Check build config files for syntax/schema issues
├── Dependency error → Check package.json, run npm install
└── Environment error → Check Node version, OS compatibility
```

```
Runtime error:
├── TypeError: Cannot read property 'x' of undefined
│   └── Something is null/undefined that shouldn't be
│       → Check data flow: where does this value come from?
├── Network error / CORS
│   └── Check URLs, headers, server CORS config
├── Render error / White screen
│   └── Check error boundary, console, component tree
└── Unexpected behavior (no error)
    └── Add logging at key points, verify data at each step
```

## Repair

### Prove it — the failing test (step 4)

The Prove-It cycle and its worked example live in `test-driven-development`;
assertion shapes and naming are in `testing-patterns.md`. What the debugging
branch adds: the test asserts the mechanism the report named, not the area around
it, so a fix elsewhere cannot turn it green.

### Safe fallbacks — when the root fix has to wait (step 5)

A fallback keeps the surface usable while the cause stays open; it is a second
change on top of the report, not a substitute for it.

```typescript
// Safe default + warning (instead of crashing)
function getConfig(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.warn(`Missing config: ${key}, using default`);
    return DEFAULTS[key] ?? '';
  }
  return value;
}

// Graceful degradation (instead of broken feature)
function renderChart(data: ChartData[]) {
  if (data.length === 0) {
    return <EmptyState message="No data available for this period" />;
  }
  try {
    return <Chart data={data} />;
  } catch (error) {
    console.error('Chart render failed:', error);
    return <ErrorState message="Unable to display chart" />;
  }
}
```

### Verify — the end-to-end sweep (step 6)

```bash
# Run the specific test
npm test -- --grep "specific test"

# Run the full test suite (check for regressions)
npm test

# Build the project (check for type/compilation errors)
npm run build

# Manual spot check if applicable
npm run dev  # Verify in browser
```

### Instrumentation — what to add, remove, and keep (steps 2 and 5)

**Add it when:**
- Reading the code cannot localize the failure to a specific line
- The issue is intermittent and needs monitoring
- The fix involves multiple interacting components

**Remove it when:**
- The bug is fixed and a test guards against recurrence
- The log is only useful during development (not in production)
- It contains sensitive data (always remove these)

**Keep it (permanent instrumentation):**
- Error boundaries with error reporting
- API error logging with request context
- Performance metrics at key user flows

Instrumentation shipped to production belongs to
`observability-and-instrumentation`; this section covers what you add to find
one bug.
