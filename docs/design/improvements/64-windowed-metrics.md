English | [繁體中文](64-windowed-metrics.zh-TW.md)

# 64 — Metrics over a window, per week, and from the terminal

**Status: implemented.**

## The problem

The hub's Metrics tab folded the whole of `runs/` into one number per
metric, so a regression this month read as a rounding error against a year
of history, and there was no trend at all. The arithmetic lived in the hub
package, so the terminal the loop is driven from had no way to ask "is the
loop getting better" without a browser.

## What changed

- **`workflow/metrics-aggregate.ts`** in core holds the pass-level half —
  `iterationBurn`, `firstPassYield`, `stageDurations`, `outcomeTally`,
  `stageLabel`, `isCheckRow` and their types — moved from the hub, which
  re-exports them. The unit stays the pass.
- **`MetricsWindow`** (`since`, `kind`) narrows the population BEFORE
  anything is counted: `windowInputs` filters passes by `at`/`kind` and
  sidecar entries by `endedAt`/`kind`, dropping inputs left empty so
  `runsTotal` says what the window covers. A kind-less pass counts as
  engineering (historical logs). `parseWindow` reads `7d`/`30d`/`all`.
- **`weeklyTrend`**: passes, done, cap-trip and first-pass rates per UTC ISO
  week, oldest first, newest 12.
- **The hub**: `GET /api/metrics?window=30d&kind=…` (a bad value is a 400,
  never silently `all`), window/kind chips, a trend table, and `window`
  echoed in the response so the UI cannot mislabel it; `kinds` comes from
  the unwindowed population so a filtered view still offers the rest.
- **`metrics [7d|30d|all] [kind]`** on both hosts (`workflow_metrics`),
  over `readRunInputs` — the one reader the hub route now uses too — and
  `formatMetricsHeadline`, so the terminal and the tab cannot disagree.

## Sharp edges

- **Filter first, count second.** Every rate must measure the same slice;
  filtering a finished response would leave `runsTotal` describing another.
- **The weekly trend uses `at`, never file order.** A run log's passes are
  appended, but one file spans weeks.
