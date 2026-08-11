English | [繁體中文](25-plan-quality-metrics.zh-TW.md)

# 25 — Plan quality gets its own numbers

**Status: implemented.**

## The problem

The Metrics tab measured everything about a run except the thing the human
gates spend most of their judgement on: the plan. `capTripRate` was the sole
proxy for "the plans are bad", and it conflates a bad plan with a hard task
and a flaky suite. Meanwhile the evidence was already on disk — plan-stage
passes in the sidecars, the park gate's contract-refusal details, and (since
plan 22) per-sample check provenance — and none of it was aggregated.

## What changed

- **`plans`** on `MetricsResponse` (`packages/hub/src/shared/api.ts`,
  `planStats` in `server/metrics/aggregate.ts`): `runsWithPlanPass`,
  `replannedRuns` (a run file whose sidecar holds ≥2 plan-stage passes — one
  file accumulates a task's passes, so a rejected-then-replanned plan is
  visible as exactly that), `replanRate` (null when unmeasured, like every
  other rate), and `contractRefusals` — sidecar `error` entries whose detail
  matches the park gate's own refusal strings. Those strings are now exported
  consts (`PARK_NO_PLAN_WHY`/`PARK_NO_VERIFICATION_WHY`,
  `packages/core/src/workflow/terminal.ts`) and the aggregate imports them —
  a hand-copied string there is how writer and matcher drift and the count
  silently reads zero forever.
- **`discovery`** (`discoveryStats`): check-stage firings tallied by
  `checksSource` (config / manifest / discovered / none) plus `refusedTotal`.
  A firing is one (entry × stage × iteration): the OpenCode host stamps every
  fan-out pass's sample with the same provenance, so the first sample of each
  group wins and a lens fan-out is not counted N times.
- **The UI** (`web/metrics/MetricsTab.tsx`): one plan-quality chip row —
  replan rate (gated red above 50%), contract refusals, checks-by-source, and
  refused checks — sitting beside the existing cap-trip chip it
  contextualizes.

## What was deliberately not done

- No per-task (cross-file) joins: the pass stays the unit of analysis, per the
  aggregate's own module note; a run FILE is already per-task for the backlog
  source, which is what `replannedRuns` leans on.
- No log-derived plan stats: the run log's footer does not distinguish a plan
  pass; the sidecar population is the honest denominator and is named as such.

## Where it lives

`PlanQualityStats`/`DiscoveryStats` in `packages/hub/src/shared/api.ts`;
`planStats`/`discoveryStats` in `packages/hub/src/server/metrics/aggregate.ts`;
the chip row in `packages/hub/src/web/metrics/MetricsTab.tsx`; the exported
refusal consts in `packages/core/src/workflow/terminal.ts`. Tests:
`aggregate.test.ts` (replanned-run counting, refusal matching against the
imported consts, per-firing dedupe under fan-out).
