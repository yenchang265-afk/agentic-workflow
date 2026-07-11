import { useEffect, useState } from "react"
import type { BacklogResponse, KindBoardInfo, TaskCard } from "../../shared/api.js"
import { fetchJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"

/**
 * The backlog board for one loop kind: one column per manifest status, task
 * cards from frontmatter, gate columns (park/done targets from the manifest's
 * transitions) highlighted — those are where the loop is waiting on a human.
 * Engineering-only lifecycle chips render when the server sends its summary.
 */

const Card = ({ task, gated, claimed }: { task: TaskCard; gated: boolean; claimed: boolean }) => (
  <div className={`card${gated ? " gated" : ""}`} title={task.acceptance.join("\n")}>
    <div className="card-title">{task.title}</div>
    <div className="card-meta">
      <span className="badge">{task.id}</span>
      {task.type && <span className="badge">{task.type}</span>}
      {task.hasPlan && <span className="badge ok">plan</span>}
      {claimed && <span className="badge gate">claimed</span>}
      {gated && <span className="badge gate">awaiting you</span>}
      {task.labels.map((l) => (
        <span key={l} className="badge">
          {l}
        </span>
      ))}
    </div>
  </div>
)

export const Board = ({ info }: { info: KindBoardInfo }) => {
  const [data, setData] = useState<BacklogResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { versions } = useEvents()
  const { repoId } = useRepo()

  useEffect(() => {
    fetchJson<BacklogResponse>(repoPath(`/api/backlog?kind=${encodeURIComponent(info.kind)}`, repoId))
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
  }, [versions.backlog, versions.gate, repoId, info.kind])

  if (error) return <div className="error-banner">Could not load backlog: {error}</div>
  if (!data) return <div className="placeholder">Loading backlog…</div>

  const { summary } = data
  const gateCount = data.gateStatuses.reduce((n, status) => n + (data.tasks[status]?.length ?? 0), 0)
  const claimed = new Set(data.claimedIds)

  return (
    <div>
      <div className="summary-chips">
        {gateCount > 0 && (
          <span className="chip gate">
            <strong>{gateCount}</strong> awaiting your review
          </span>
        )}
        {info.pools.map((status) => (
          <span key={status} className="chip">
            {status} <strong>{data.tasks[status]?.length ?? 0}</strong>
          </span>
        ))}
        {summary && summary.interrupted.length > 0 && (
          <span className="chip gate">
            interrupted <strong>{summary.interrupted.length}</strong>
          </span>
        )}
        {data.anomalies && <span className="chip gate">backlog anomalies — run doctor</span>}
      </div>
      <div className="board">
        {data.statuses.map((status) => {
          const tasks = data.tasks[status] ?? []
          const gate = data.gateStatuses.includes(status)
          return (
            <div key={status} className={`column${gate ? " gate-column" : ""}`}>
              <div className="column-title">
                <span>{status}</span>
                <span>{tasks.length}</span>
              </div>
              {tasks.map((t) => (
                <Card key={t.id} task={t} gated={gate} claimed={claimed.has(t.id)} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
