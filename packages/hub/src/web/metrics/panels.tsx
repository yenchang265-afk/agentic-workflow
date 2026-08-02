import { formatDuration } from "@agentic-workflow/core/workflow/metrics"
import { Fragment } from "react"
import type {
  CacheHit,
  FanoutStats,
  FindingsStats,
  IterationBurn,
  ModelStats,
  PromptSize,
  StageDuration,
  StageVerdicts,
  ToolStats,
  VerdictFlips,
} from "../../shared/api.js"
import { barWidth, bucketLabel, formatChars, formatTokens, pct } from "./format.js"

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
      <tfoot>
        <tr>
          <td className="muted" colSpan={4}>
            overall {pct(cache.ratio)} · {formatTokens(cache.cacheRead)} cached of {formatTokens(cache.input + cache.cacheRead)} in ·{" "}
            {cache.samples} sample(s)
          </td>
        </tr>
      </tfoot>
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

/**
 * Which model ran which stage, at what cost and retry burn. Sidecar samples
 * only (see `modelStats`) — the coverage caveat renders in the tab footer.
 */
export const ModelTable = ({ models }: { models: ModelStats }) => {
  if (models.rows.length === 0)
    return <div className="muted">No sample recorded its model — only the opencode driver binds one per stage.</div>
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th>model</th>
          <th>cost</th>
          <th>mean time</th>
          <th title="mean 1-based iteration of this pairing's samples — retries show up here">mean iter</th>
          <th>samples</th>
        </tr>
      </thead>
      <tbody>
        {models.rows.map((r) => (
          <tr key={`${r.stage}-${r.model}`}>
            <td>{r.stage}</td>
            <td>{r.model}</td>
            <td>{r.costSamples === 0 ? "—" : `$${r.totalCost.toFixed(4)}`}</td>
            <td>{formatDuration(r.meanMs)}</td>
            <td>{r.meanIteration.toFixed(1)}</td>
            <td>{r.samples}</td>
          </tr>
        ))}
      </tbody>
      {models.samplesWithoutModel > 0 && (
        <tfoot>
          <tr>
            <td className="muted" colSpan={6}>
              {models.samplesWithoutModel} sample(s) recorded no model and are excluded
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

/**
 * Recurring review findings, most-repeated first. The trigger this table exists
 * for: "VERIFY/REVIEW keeps flagging the same class of defect" — the CLAUDE.md
 * maintenance rule — without re-reading run logs by hand.
 */
export const FindingsTable = ({ findings }: { findings: FindingsStats }) => {
  if (findings.topFindings.length === 0)
    return <div className="muted">No structured findings recorded yet (sidecars written before capture, or reviews found nothing).</div>
  return (
    <>
      <table className="stage-table">
        <thead>
          <tr>
            <th>axis</th>
            <th>severity</th>
            <th>finding</th>
            <th>seen</th>
            <th>stages</th>
          </tr>
        </thead>
        <tbody>
          {findings.topFindings.map((f, i) => (
            <tr key={i}>
              <td>{f.axis}</td>
              <td>
                <span className={`badge${f.severity === "suggestion" ? "" : " gate"}`}>{f.severity}</span>
              </td>
              <td>{f.detail}</td>
              <td>{f.count}</td>
              <td className="muted">{f.stages.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted token-totals">
        {Object.entries(findings.bySeverity)
          .map(([severity, count]) => `${severity} ${count}`)
          .join(" · ")}
        {` · in ${findings.samplesWithFindings} check pass(es) over ${findings.runsCovered} run(s)`}
      </div>
    </>
  )
}

/**
 * Fan-out multiplier of focused (lens/axis) check stages. Every pass pays the
 * whole composed prompt again, so the number that matters is the per-arming
 * SUM — a five-lens review is five prompts, not one.
 */
export const FanoutTable = ({ fanout }: { fanout: FanoutStats }) => {
  if (fanout.stages.length === 0)
    return <div className="muted">No stage ran focused (lens/axis) passes — single-pass checks have no fan-out.</div>
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th title="stage firings that ran at least one focused pass">armings</th>
          <th title="distinct focuses per arming — retries of one focus don't inflate this">passes / arming</th>
          <th>max</th>
          <th title="mean per-arming sum of prompt sizes — what one fanned-out firing costs">prompt / arming</th>
        </tr>
      </thead>
      <tbody>
        {fanout.stages.map((s) => (
          <tr key={s.stage}>
            <td>{s.stage}</td>
            <td>{s.armings}</td>
            <td>{s.meanPasses.toFixed(1)}</td>
            <td>{s.maxPasses}</td>
            <td>{s.meanArmingPromptChars === null ? "—" : formatChars(s.meanArmingPromptChars)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Flakiest tools first: per-tool call/error totals across every sidecar. */
export const ToolTable = ({ tools }: { tools: readonly ToolStats[] }) => {
  if (tools.length === 0) return <div className="muted">No sidecar recorded tool activity yet.</div>
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>tool</th>
          <th>calls</th>
          <th>errors</th>
          <th>error rate</th>
          <th>runs</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={t.tool}>
            <td>{t.tool}</td>
            <td>{t.calls}</td>
            <td>{t.errors}</td>
            <td>{pct(t.errorRate, 1)}</td>
            <td>{t.runsCovered}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Composed-prompt size per stage. Unlike the cache ratio this covers BOTH hosts,
 * so its coverage line reads the opposite way — see `promptSize`.
 */
export const PromptSizeTable = ({ prompt }: { prompt: PromptSize }) => {
  if (prompt.stages.length === 0) {
    return <div className="muted">No sample recorded a prompt size (sidecars written before this was tracked).</div>
  }
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th>mean</th>
          <th>median</th>
          <th>max</th>
          <th>elided</th>
          <th>samples</th>
        </tr>
      </thead>
      <tbody>
        {prompt.stages.map((p) => (
          <Fragment key={p.stage}>
            <tr>
              <td>{p.stage}</td>
              <td>{formatChars(p.meanChars)}</td>
              <td>{formatChars(p.medianChars)}</td>
              <td>{formatChars(p.maxChars)}</td>
              {/* Blank, not "0", when no budget is configured — nothing was elided
                  because nothing could be, which is not the same as a budget that
                  never bit. */}
              <td>{p.elidedSamples === 0 ? "—" : `${formatChars(p.elidedChars)} in ${p.elidedSamples}`}</td>
              <td>{p.samples}</td>
            </tr>
            {p.focuses?.map((f) => (
              <tr key={`${p.stage}·${f.focus}`} className="muted">
                <td>&nbsp;&nbsp;· {f.focus}</td>
                <td>{formatChars(f.meanChars)}</td>
                <td>—</td>
                <td>{formatChars(f.maxChars)}</td>
                <td>—</td>
                <td>{f.samples}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className="muted" colSpan={6}>
            {prompt.samples} sample(s) across {prompt.stages.length} stage(s)
          </td>
        </tr>
      </tfoot>
    </table>
  )
}
