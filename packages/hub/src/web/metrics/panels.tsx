import { formatDuration } from "@agentic-workflow/core/workflow/metrics"
import type { CacheHit, IterationBurn, StageDuration, StageVerdicts, VerdictFlips } from "../../shared/api.js"
import { barWidth, bucketLabel, pct } from "./format.js"

/** The metrics tab's panels. Presentation only — every number is computed server-side. */

const BAR_WIDTH = 260

/**
 * Iteration burn, as a histogram rather than a table.
 *
 * The finding here is the distribution's SHAPE, which five integers in a row of
 * cells cannot show: a healthy loop is left-skewed, and a spike in the closed
 * 100% bucket means the cap is doing work the checks should be doing. Bars are
 * hand-rolled SVG, matching `TokenPanel`'s — this package has no chart
 * dependency and should not grow one for five rectangles.
 */
export const BurnHistogram = ({ burn }: { burn: IterationBurn }) => {
  if (burn.passesMeasured === 0)
    return (
      <div className="muted">
        No pass recorded an iteration cap.
        {burn.passesUnmeasured > 0 && ` ${burn.passesUnmeasured} pass(es) predate the run-log footer that carries it.`}
      </div>
    )

  const max = Math.max(...burn.buckets.map((b) => b.passes))
  return (
    <div className="burn-histogram">
      {burn.buckets.map((bucket) => (
        <div key={bucket.from} className="burn-row">
          <span className="burn-label">{bucketLabel(bucket)}</span>
          <svg width={BAR_WIDTH} height={14} role="img" aria-label={`${bucket.passes} passes`}>
            <rect
              x={0}
              y={2}
              width={barWidth(bucket.passes, max, BAR_WIDTH)}
              height={10}
              rx={2}
              className={`bar-burn${bucket.from === 1 ? " capped" : ""}`}
            />
          </svg>
          <span className="burn-count">{bucket.passes}</span>
        </div>
      ))}
      <div className="muted">
        a ratio of each pass's own cap, because caps differ across kinds · mean {pct(burn.meanRatio)} · median{" "}
        {pct(burn.medianRatio)}
        {burn.passesUnmeasured > 0 && ` · ${burn.passesUnmeasured} pass(es) recorded no cap and are excluded`}
      </div>
    </div>
  )
}

export const VerdictTable = ({ verdicts, flips }: { verdicts: readonly StageVerdicts[]; flips: VerdictFlips }) => {
  if (verdicts.length === 0) return <div className="muted">No pass recorded a verdict yet.</div>
  return (
    <>
      <table className="stage-table">
        <thead>
          <tr>
            <th>stage</th>
            <th>pass</th>
            <th>fail</th>
            <th>error</th>
            <th>none</th>
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => (
            <tr key={v.stage}>
              <td>{v.stage}</td>
              <td>{v.pass}</td>
              <td>{v.fail}</td>
              <td>{v.error}</td>
              <td title="the check ran and declined to judge">{v.none}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted token-totals">
        flips · recovered (fail→pass) {flips.failToPass} · regressed (pass→fail) {flips.passToFail} · stuck (fail→fail){" "}
        {flips.failToFail} · in {flips.passesWithFlips} pass(es)
      </div>
    </>
  )
}

/**
 * Per-stage cache hit, with the same two-segment bar vocabulary `TokenPanel`
 * already uses for the same quantity — reusing `.bar-cache`/`.bar-in` keeps one
 * visual language for cached-vs-fresh input rather than inventing a second.
 */
export const CacheTable = ({ cache }: { cache: CacheHit }) => {
  if (cache.stages.length === 0)
    return <div className="muted">No run observed token usage — only the opencode driver records it.</div>
  const max = Math.max(...cache.stages.map((s) => s.input + s.cacheRead))
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th>cached vs fresh</th>
          <th>hit</th>
          <th>samples</th>
        </tr>
      </thead>
      <tbody>
        {cache.stages.map((s) => (
          <tr key={s.stage}>
            <td>{s.stage}</td>
            <td>
              <svg width={BAR_WIDTH} height={14} role="img" aria-label={`cache hit ${pct(s.ratio)}`}>
                <rect
                  x={0}
                  y={2}
                  width={barWidth(s.cacheRead, max, BAR_WIDTH)}
                  height={10}
                  rx={2}
                  className="bar-cache"
                />
                <rect
                  x={barWidth(s.cacheRead, max, BAR_WIDTH)}
                  y={2}
                  width={barWidth(s.input, max, BAR_WIDTH)}
                  height={10}
                  rx={2}
                  className="bar-in"
                />
              </svg>
            </td>
            <td>{pct(s.ratio)}</td>
            <td>{s.samples}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export const DurationTable = ({ durations }: { durations: readonly StageDuration[] }) => {
  if (durations.length === 0) return <div className="muted">No pass recorded a wall-clock time.</div>
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th>mean</th>
          <th>median</th>
          <th>max</th>
          <th>rows</th>
        </tr>
      </thead>
      <tbody>
        {durations.map((d) => (
          <tr key={d.stage}>
            <td>{d.stage}</td>
            <td>{formatDuration(d.meanSeconds * 1000)}</td>
            <td>{formatDuration(d.medianSeconds * 1000)}</td>
            <td>{formatDuration(d.maxSeconds * 1000)}</td>
            <td>{d.rows}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
