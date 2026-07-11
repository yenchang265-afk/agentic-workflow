import { useEffect, useState } from "react"
import type { RunDetailResponse, RunsResponse } from "../../shared/api.js"
import { fetchJson } from "../api.js"
import { useEvents } from "../events.js"
import { TokenPanel } from "./TokenPanel.js"

/** Run history: list of run logs; expanding one shows stage sections + summary tables. */

const outcomeClass = (outcome?: string): string =>
  outcome === "done" ? "ok" : outcome === "error" || outcome === "stopped" ? "gate" : ""

const RunDetail = ({ id }: { id: string }) => {
  const [detail, setDetail] = useState<RunDetailResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    fetchJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message))
  }, [id])

  if (error) return <div className="error-banner">{error}</div>
  if (!detail) return <div className="placeholder">Loading run…</div>

  return (
    <div className="run-detail">
      {detail.snapshot && (
        <div className="summary-chips">
          <span className="chip gate">
            snapshot: parked at <strong>{detail.snapshot.stage}</strong> (iteration {detail.snapshot.iteration + 1})
            {detail.snapshot.branch ? ` on ${detail.snapshot.branch}` : ""}
          </span>
        </div>
      )}
      {detail.log.summaries.map((s, i) => (
        <div key={i} className="run-summary">
          <div className="run-summary-head">
            <span className={`badge ${outcomeClass(s.outcome)}`}>{s.outcome}</span>
            {s.detail && <span>{s.detail}</span>}
            <span className="muted">{s.at}</span>
            {s.total && (
              <span className="muted">
                total {s.total} · iterations {s.iterationsUsed}/{s.cap}
              </span>
            )}
          </div>
          {s.rows.length > 0 && (
            <table className="stage-table">
              <thead>
                <tr>
                  <th>stage</th>
                  <th>iter</th>
                  <th>verdict</th>
                  <th>wall-clock</th>
                  {Object.keys(s.rows[0]?.extra ?? {}).map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, j) => (
                  <tr key={j}>
                    <td>{r.lens ? `${r.stage} (${r.lens})` : r.stage}</td>
                    <td>{r.iteration}</td>
                    <td>
                      {r.verdict ? <span className={`badge ${r.verdict === "PASS" ? "ok" : "gate"}`}>{r.verdict}</span> : "—"}
                    </td>
                    <td>{r.duration}</td>
                    {Object.values(r.extra).map((v, k) => (
                      <td key={k}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {detail.log.sections.map((sec, i) => (
        <details key={i} className="stage-section">
          <summary>
            {sec.lens ? `${sec.stage} (${sec.lens})` : sec.stage} · iteration {sec.iteration}{" "}
            <span className="muted">{sec.at}</span>
          </summary>
          <pre>{sec.body}</pre>
        </details>
      ))}
      {detail.log.sections.length === 0 && detail.log.summaries.length === 0 && (
        <div className="placeholder">Run log is empty.</div>
      )}
      <TokenPanel runId={id} />
    </div>
  )
}

export const Runs = () => {
  const [data, setData] = useState<RunsResponse | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { versions } = useEvents()

  useEffect(() => {
    fetchJson<RunsResponse>("/api/runs")
      .then(setData)
      .catch(() => setData({ runs: [] }))
  }, [versions.run])

  if (!data) return null
  if (data.runs.length === 0) return <div className="placeholder">No run logs yet.</div>

  return (
    <div className="runs">
      <div className="runs-list">
        {data.runs.map((r) => (
          <button
            key={r.id}
            className={`run-row${selected === r.id ? " active" : ""}`}
            onClick={() => setSelected(selected === r.id ? null : r.id)}
          >
            <span className="run-id">{r.id}</span>
            {r.outcome && <span className={`badge ${outcomeClass(r.outcome)}`}>{r.outcome}</span>}
            {r.detail && <span className="muted">{r.detail}</span>}
            {r.at && <span className="muted">{new Date(r.at).toLocaleString()}</span>}
          </button>
        ))}
      </div>
      {selected && <RunDetail id={selected} />}
    </div>
  )
}
