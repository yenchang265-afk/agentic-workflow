---
name: performance-optimization
description: Finds unbounded work in a diff, and optimizes only what measurement proves matters. Use when a change touches a hot path, a query, a loop over unbounded data, or a cache that only grows; also when a running system is measurably slow, Core Web Vitals included.
---

# Performance Optimization

Two branches, and they ask opposite questions.

**Judging a diff** — you cannot run the code, profile it, or produce a number.
So don't try to answer "is this slow?"; answer the question a diff *can* answer:
does each piece of work have a **bound**? Everything below is this branch.

**Optimizing a real system** — you have a running system and a symptom. Measure
first; the whole method is in `references/performance-checklist.md`, summarized
at the end of this file.

## Judging a diff

For every loop, query, fetch, allocation, and render the diff introduces or
touches, name two things: its **bound** (what stops it growing) and its per-item
cost. Work with no bound is the finding — you do not need a millisecond figure
to report it, and guessing one weakens the finding.

**Where the bound goes missing:**

- **Per-item query (N+1).** A query inside a loop over rows: one query becomes
  one per row. The bound is a join, an `include`, or batch loading.
- **Unbounded fetch.** `findMany()` with no `take`, a list endpoint with no
  pagination, a "get all" that grows with the table.
- **Per-item `await`.** Sequential awaits in a loop where the work is
  independent — the bound is a batch or a bounded-concurrency map.
- **Unbounded accumulation.** A cache, map, or array that only ever grows, with
  no TTL, no eviction, and no size cap. This is the one that survives review and
  pages someone at 3am.
- **Work moved onto a hot path.** The diff adds work inside a request handler,
  a render, or a frame callback that could sit outside it. A hot path is any
  code whose cost multiplies by traffic, rows, or frames.
- **Unbounded input.** A regex, parse, or recursion applied to input whose size
  the caller controls, with no length cap.
- **Layout thrash.** Interleaved DOM reads and writes in a loop — batch the
  reads, then the writes.
- **Memoization without evidence.** `React.memo`/`useMemo` added across a diff
  with no profile naming the cost. Memoize only what profiling names; a wrapper
  around a cheap component costs more than it saves.

**Note what the diff already bounds.** Saying "the list endpoint paginates and
the cache has a TTL" calibrates trust in the findings that remain.

## Severity

Grade with the three severities `code-review-and-quality` → Severity defines —
that skill owns the vocabulary. What performance adds is where the line sits:

- `critical` — unbounded growth on a request path: memory that never releases,
  a query whose cost scales with a table the user can grow, an unbounded loop
  over attacker-influenced input.
- `important` — unbounded work off a hot path, an N+1 on a cold path, or a
  measured regression against a budget the repo actually defines.
- `suggestion` — a suspicion you have not measured, and micro-optimizations.
  "This feels slow" with no bound behind it is never a blocker.

## Optimizing a real system

When you *can* run it, measurement leads and nothing is optimized without it —
premature optimization buys complexity with no evidence it bought speed:

```
1. MEASURE  → Establish baseline with real data (synthetic + RUM)
2. IDENTIFY → Find the actual bottleneck (not the assumed one)
3. FIX      → Address that specific bottleneck
4. VERIFY   → Measure again, confirm the improvement
5. GUARD    → Add monitoring or a CI budget to prevent regression
```

Your machine is not the user's, so profile on representative hardware and
networks. Core Web Vitals targets, the symptom-to-measurement tree, bottleneck
tables, measurement commands, budgets, and worked fixes all live in
`references/performance-checklist.md`.

## Verification

Judging a diff:

- [ ] Every loop, query, fetch, allocation, and render in the diff has a named bound, or is a finding
- [ ] Every finding names the bound that is missing and the move that adds it, at `file:line`
- [ ] No finding rests on an invented millisecond figure
- [ ] What the diff already bounds is stated, not left silent

Changing a real system:

- [ ] Before and after measurements exist, as specific numbers
- [ ] The bottleneck was identified by measurement, not assumption
- [ ] Core Web Vitals are within "Good" thresholds
- [ ] Bundle size hasn't grown unreviewed; the CI budget passes if one is configured
- [ ] Existing tests still pass — the optimization didn't change behavior
