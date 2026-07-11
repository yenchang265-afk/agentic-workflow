import { useEffect, useState } from "react"
import type { ActiveResponse } from "../../shared/api.js"
import { fetchJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"

/** Live activity strip: current stage (Claude host), watch lease, resumable snapshots, PR ledgers. */

const Deadline = ({ deadline }: { deadline: number | null | undefined }) => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (deadline == null) return null
  const left = Math.max(0, Math.round((deadline - now) / 1000))
  const text = left >= 60 ? `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s` : `${left}s`
  return <span className={`badge${left === 0 ? " gate" : ""}`}>{left === 0 ? "overdue" : `deadline ${text}`}</span>
}

export const ActivePanel = () => {
  const [data, setData] = useState<ActiveResponse | null>(null)
  const { versions } = useEvents()
  const { repoId } = useRepo()

  useEffect(() => {
    fetchJson<ActiveResponse>(repoPath("/api/active", repoId))
      .then(setData)
      .catch(() => setData(null))
  }, [versions.active, repoId])

  if (!data) return null
  const idle = !data.stage && !data.lease && data.snapshotIds.length === 0 && data.prLedgers.length === 0

  return (
    <div className="active-panel">
      {idle && <span className="chip">no loop activity</span>}
      {data.stage && (
        <span className="chip gate">
          running <strong>{data.stage.kind ?? "engineering"}/{data.stage.stage}</strong>
          {data.stage.taskId ? <> on <strong>{data.stage.taskId}</strong></> : null}{" "}
          <Deadline deadline={data.stage.deadline} />
        </span>
      )}
      {data.lease && (
        <span className={`chip${data.lease.stale ? " gate" : ""}`}>
          watcher {data.lease.stale ? "stale" : "live"} — pid {data.lease.pid} ({data.lease.host})
        </span>
      )}
      {data.snapshotIds.length > 0 && (
        <span className="chip">
          resumable snapshots: <strong>{data.snapshotIds.join(", ")}</strong>
        </span>
      )}
      {data.prLedgers.map((l) => (
        <span key={l.pr} className="chip">
          PR #{l.pr}
          {l.failedAttempts > 0 ? ` · ${l.failedAttempts} failed attempts` : ""}
        </span>
      ))}
    </div>
  )
}
