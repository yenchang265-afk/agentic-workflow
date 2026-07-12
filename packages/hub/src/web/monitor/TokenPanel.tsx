import type { RunTokensResponse, StageTokens } from "../../shared/api.js"
import { repoPath, useRepo } from "../repo.js"
import { useJson } from "../useJson.js"

/** Per-stage token usage for one run: hand-rolled stacked SVG bars, no chart dep. */

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const inTotal = (t: StageTokens): number => t.input + t.cacheRead + t.cacheWrite
const outTotal = (t: StageTokens): number => t.output + t.reasoning

const Bar = ({ tokens, max }: { tokens: StageTokens; max: number }) => {
  const width = 260
  const scale = (n: number): number => (max > 0 ? Math.max(n > 0 ? 1 : 0, (n / max) * width) : 0)
  const wCache = scale(tokens.cacheRead + tokens.cacheWrite)
  const wIn = scale(tokens.input)
  const wOut = scale(outTotal(tokens))
  return (
    <svg width={width} height={14} role="img" aria-label={`in ${fmt(inTotal(tokens))}, out ${fmt(outTotal(tokens))}`}>
      <rect x={0} y={2} width={wCache} height={10} rx={2} className="bar-cache" />
      <rect x={wCache} y={2} width={wIn} height={10} rx={2} className="bar-in" />
      <rect x={wCache + wIn} y={2} width={wOut} height={10} rx={2} className="bar-out" />
    </svg>
  )
}

export const TokenPanel = ({ runId }: { runId: string }) => {
  const { repoId } = useRepo()
  const { data, error } = useJson<RunTokensResponse>(repoPath(`/api/tokens/${encodeURIComponent(runId)}`, repoId), [
    runId,
    repoId,
  ])

  if (error) return null
  if (!data) return <div className="placeholder">Loading token usage…</div>
  if (data.rows.length === 0)
    return (
      <div className="token-panel">
        <h3>Token usage</h3>
        <div className="muted">No usage data for this run.{data.notes.length > 0 && ` ${data.notes.join(" · ")}`}</div>
      </div>
    )

  const max = Math.max(...data.rows.map((r) => inTotal(r.tokens) + outTotal(r.tokens)))
  return (
    <div className="token-panel">
      <h3>Token usage</h3>
      <table className="stage-table">
        <thead>
          <tr>
            <th>stage</th>
            <th>usage</th>
            <th>in (cache)</th>
            <th>out</th>
            <th>cost</th>
            <th>source</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i}>
              <td>
                {r.lens ? `${r.stage} (${r.lens})` : r.stage} <span className="muted">#{r.iteration}</span>
              </td>
              <td>
                <Bar tokens={r.tokens} max={max} />
              </td>
              <td>
                {fmt(r.tokens.input)} <span className="muted">({fmt(r.tokens.cacheRead + r.tokens.cacheWrite)})</span>
              </td>
              <td>{fmt(outTotal(r.tokens))}</td>
              <td>{r.cost !== undefined ? `$${r.cost.toFixed(4)}` : "—"}</td>
              <td>
                <span className={`badge${r.estimated ? " gate" : " ok"}`} title={r.estimated ? "attributed by time window" : "observed"}>
                  {r.source}
                  {r.estimated ? " ~" : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted token-totals">
        total in {fmt(inTotal(data.totals))} · out {fmt(outTotal(data.totals))}
        {data.cost !== undefined && ` · cost $${data.cost.toFixed(4)}`}
        {data.notes.length > 0 && ` · ${data.notes.join(" · ")}`}
      </div>
    </div>
  )
}
