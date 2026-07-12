import type { BacklogResponse, KindBoardInfo, TaskCard } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useJson } from "../useJson.js"
import { Badge } from "../ui/Badge.js"
import { Card } from "../ui/Card.js"
import { Chip } from "../ui/Chip.js"

/**
 * The backlog board for one loop kind: one column per manifest status, task
 * cards from frontmatter, gate columns (park/done targets from the manifest's
 * transitions) highlighted — those are where the loop is waiting on a human.
 * Engineering-only lifecycle chips render when the server sends its summary.
 */

const TaskCardView = ({ task, gated, claimed }: { task: TaskCard; gated: boolean; claimed: boolean }) => (
  <Card gated={gated} title={task.acceptance.join("\n")}>
    <div className="card-title">{task.title}</div>
    <div className="card-meta">
      <Badge>{task.id}</Badge>
      {task.type && <Badge>{task.type}</Badge>}
      {task.hasPlan && <Badge tone="ok">plan</Badge>}
      {claimed && <Badge tone="gate">claimed</Badge>}
      {gated && <Badge tone="gate">awaiting you</Badge>}
      {task.labels.map((l) => (
        <Badge key={l}>{l}</Badge>
      ))}
    </div>
  </Card>
)

export const Board = ({ info }: { info: KindBoardInfo }) => {
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const { data, error } = useJson<BacklogResponse>(
    repoPath(`/api/backlog?kind=${encodeURIComponent(info.kind)}`, repoId),
    [versions.backlog, versions.gate, repoId, info.kind],
  )

  if (error) return <div className="error-banner">Could not load backlog: {error}</div>
  if (!data) return <div className="placeholder">Loading backlog…</div>

  const { summary } = data
  const gateCount = data.gateStatuses.reduce((n, status) => n + (data.tasks[status]?.length ?? 0), 0)
  const claimed = new Set(data.claimedIds)

  return (
    <div>
      <div className="summary-chips">
        {gateCount > 0 && (
          <Chip gate>
            <strong>{gateCount}</strong> awaiting your review
          </Chip>
        )}
        {info.pools.map((status) => (
          <Chip key={status}>
            {status} <strong>{data.tasks[status]?.length ?? 0}</strong>
          </Chip>
        ))}
        {summary && summary.interrupted.length > 0 && (
          <Chip gate>
            interrupted <strong>{summary.interrupted.length}</strong>
          </Chip>
        )}
        {data.anomalies && <Chip gate>backlog anomalies — run doctor</Chip>}
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
                <TaskCardView key={t.id} task={t} gated={gate} claimed={claimed.has(t.id)} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
