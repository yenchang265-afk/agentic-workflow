import { useEffect, useState } from "react"
import type { ActiveResponse } from "../../shared/api.js"
import { fetchJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { Badge } from "../ui/Badge.js"
import { Chip } from "../ui/Chip.js"

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
  return <Badge tone={left === 0 ? "gate" : "neutral"}>{left === 0 ? "overdue" : `deadline ${text}`}</Badge>
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
      {idle && <Chip>no loop activity</Chip>}
      {data.stage && (
        <Chip gate>
          running <strong>{data.stage.kind ?? "engineering"}/{data.stage.stage}</strong>
          {data.stage.taskId ? <> on <strong>{data.stage.taskId}</strong></> : null}{" "}
          <Deadline deadline={data.stage.deadline} />
        </Chip>
      )}
      {data.lease && (
        <Chip gate={data.lease.stale}>
          watcher {data.lease.stale ? "stale" : "live"} — pid {data.lease.pid} ({data.lease.host})
        </Chip>
      )}
      {data.snapshotIds.length > 0 && (
        <Chip>
          resumable snapshots: <strong>{data.snapshotIds.join(", ")}</strong>
        </Chip>
      )}
      {data.prLedgers.map((l) => (
        <Chip key={l.pr}>
          PR #{l.pr}
          {l.failedAttempts > 0 ? ` · ${l.failedAttempts} failed attempts` : ""}
        </Chip>
      ))}
    </div>
  )
}
