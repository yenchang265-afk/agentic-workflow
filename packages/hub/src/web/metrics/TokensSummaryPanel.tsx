import type { TokensSummaryResponse } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { barWidth, formatTokens } from "./format.js"

/**
 * Cross-run token spend: one row per run, from `GET /api/tokens`. The per-run
 * panel answers "where did THIS run's tokens go"; this answers "which runs are
 * eating the budget". Same visual vocabulary as `TokenPanel` — in/out segments
 * on a hand-rolled SVG bar, `~` badge for estimated attribution.
 */

const BAR_WIDTH = 260

export const TokensSummaryPanel = () => {
  const { repoId } = useRepo()
  const { versions } = useEvents()
  const { data, error } = useResource<TokensSummaryResponse>(repoPath("/api/tokens", repoId), [
    repoId,
    versions.tokens,
    versions.run,
  ])

  if (error) return <div className="error-banner">Could not load token spend: {error}</div>
  if (!data) return <div className="placeholder">Loading token spend…</div>
  if (data.runs.length === 0) return <div className="muted">No run has observable token usage yet.</div>

  const max = Math.max(...data.runs.map((r) => r.input + r.output))
  const totalIn = data.runs.reduce((s, r) => s + r.input, 0)
  const totalOut = data.runs.reduce((s, r) => s + r.output, 0)
  const costRuns = data.runs.filter((r) => r.cost !== undefined)
  const totalCost = costRuns.reduce((s, r) => s + (r.cost ?? 0), 0)

  return (
    <div className="token-panel">
      <table className="stage-table">
        <thead>
          <tr>
            <th>run</th>
            <th>usage</th>
            <th>in</th>
            <th>out</th>
            <th>cost</th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((r) => (
            <tr key={r.id}>
              <td>
                {r.id}
                {r.estimated && (
                  <>
                    {" "}
                    <span className="badge gate" title="attributed by time window, not exact observation">
                      ~
                    </span>
                  </>
                )}
              </td>
              <td>
                <svg width={BAR_WIDTH} height={14} role="img" aria-label={`in ${formatTokens(r.input)}, out ${formatTokens(r.output)}`}>
                  <rect x={0} y={2} width={barWidth(r.input, max, BAR_WIDTH)} height={10} rx={2} className="bar-in" />
                  <rect
                    x={barWidth(r.input, max, BAR_WIDTH)}
                    y={2}
                    width={barWidth(r.output, max, BAR_WIDTH)}
                    height={10}
                    rx={2}
                    className="bar-out"
                  />
                </svg>
              </td>
              <td>{formatTokens(r.input)}</td>
              <td>{formatTokens(r.output)}</td>
              <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted token-totals">
        total in {formatTokens(totalIn)} · out {formatTokens(totalOut)}
        {costRuns.length > 0 && ` · cost $${totalCost.toFixed(4)} over ${costRuns.length} of ${data.runs.length} run(s)`}
      </div>
    </div>
  )
}
