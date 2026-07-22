import type { MetricsResponse } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { Chip } from "../ui/Chip.js"
import { useJson } from "../useJson.js"
import { pct } from "./format.js"
import { BurnHistogram, CacheTable, DurationTable, VerdictTable } from "./panels.js"

/**
 * Cross-run loop health. The monitor answers "what is this run doing"; this
 * answers "is the loop getting better or worse", which no single run can.
 *
 * Refetches on `versions.run` and `versions.tokens` — exactly the two watcher
 * events that can change `/api/metrics`, since its only inputs are `runs/*.md`
 * and `runs/*.metrics.json`. No new SSE event type is needed for that reason.
 */
export const MetricsTab = () => {
  const { repoId } = useRepo()
  const { versions } = useEvents()
  const { data, error } = useJson<MetricsResponse>(repoPath("/api/metrics", repoId), [
    repoId,
    versions.run,
    versions.tokens,
  ])

  if (error) return <div className="error-banner">{error}</div>
  if (!data) return <div className="placeholder">Loading metrics…</div>
  if (data.runsTotal === 0) return <div className="placeholder">No runs recorded yet.</div>

  const { burn, firstPass, cache } = data
  return (
    <div className="metrics-tab">
      <div className="summary-chips">
        <Chip>
          runs <strong>{data.runsTotal}</strong>
        </Chip>
        <Chip title="terminal summaries — one run log can hold a plan pass and a build pass">
          passes <strong>{data.passesTotal}</strong>
        </Chip>
        {data.runsInProgress > 0 && (
          <Chip gate title="still accruing — absent from every pass-scoped metric below">
            in progress <strong>{data.runsInProgress}</strong>
          </Chip>
        )}
        <Chip
          gate={burn.capTripRate !== null && burn.capTripRate > 0.25}
          title="passes that ended at their iteration cap rather than by passing review"
        >
          cap-trip <strong>{pct(burn.capTripRate)}</strong>
        </Chip>
        <Chip title="passes where every check passed on the first iteration">
          first-pass yield <strong>{pct(firstPass.rate)}</strong>
        </Chip>
        <Chip title="cacheRead / (input + cacheRead), token-weighted">
          cache hit <strong>{pct(cache.ratio)}</strong>
        </Chip>
      </div>

      <div className="summary-chips">
        {Object.entries(data.outcomes).map(([outcome, count]) => (
          <Chip key={outcome} gate={outcome !== "done"}>
            {outcome} <strong>{count}</strong>
          </Chip>
        ))}
      </div>

      <h2 className="section-title">Iteration burn</h2>
      <BurnHistogram burn={burn} />

      <h2 className="section-title">Verdicts</h2>
      <VerdictTable verdicts={data.verdicts} flips={data.flips} />

      <h2 className="section-title">Cache hit</h2>
      <CacheTable cache={cache} />

      <h2 className="section-title">Stage duration</h2>
      <DurationTable durations={data.durations} />

      {/*
        Coverage stated plainly rather than left implicit in the numbers above.
        A cache ratio over 12 of 87 runs is a real measurement of a slice, and
        saying so is the difference between an honest metric and a misleading one.
      */}
      <div className="muted token-totals">
        cache ratio over {cache.runsCovered} of {data.runsTotal} run(s) — only opencode-driven runs observe tokens
        {firstPass.passesWithoutChecks > 0 &&
          ` · ${firstPass.passesWithoutChecks} pass(es) recorded no verdict and are excluded from first-pass yield`}
        {data.skippedRuns.length > 0 && ` · ${data.skippedRuns.length} run log(s) unreadable: ${data.skippedRuns.join(", ")}`}
      </div>
    </div>
  )
}
