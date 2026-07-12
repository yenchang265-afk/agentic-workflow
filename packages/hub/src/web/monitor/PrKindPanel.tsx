import { useEffect, useState } from "react"
import type { ActiveResponse, KindBoardInfo } from "../../shared/api.js"
import { fetchJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { Chip } from "../ui/Chip.js"

/**
 * Monitor view for a PR-shaped kind (workSource "github-pr"): there are no
 * status folders to board, so it surfaces the kind's description plus the
 * per-PR dedup ledgers and resumable snapshots from the live-activity data.
 * Deliberately modest — the data model records no more per PR yet.
 */
export const PrKindPanel = ({ info }: { info: KindBoardInfo }) => {
  const [data, setData] = useState<ActiveResponse | null>(null)
  const { versions } = useEvents()
  const { repoId } = useRepo()

  useEffect(() => {
    fetchJson<ActiveResponse>(repoPath("/api/active", repoId))
      .then(setData)
      .catch(() => setData(null))
  }, [versions.active, repoId])

  const ledgers = data?.prLedgers ?? []
  return (
    <div className="pr-kind">
      <p className="pr-kind-desc">{info.description}</p>
      {ledgers.length === 0 ? (
        <div className="placeholder">No PRs handled yet — ledgers appear after the first claim.</div>
      ) : (
        <div className="summary-chips">
          {ledgers.map((l) => (
            <Chip key={l.pr}>
              PR #{l.pr}
              {l.failedAttempts > 0 ? ` · ${l.failedAttempts} failed attempts` : ""}
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
