import { useEffect, useState } from "react"
import type { RunDetailResponse, RunsResponse, StageActivity } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useJson } from "../useJson.js"
import { Badge } from "../ui/Badge.js"
import { Chip } from "../ui/Chip.js"
import { TokenPanel } from "./TokenPanel.js"

/** Run history: list of run logs; expanding one shows stage sections + summary tables. */

const outcomeTone = (outcome?: string): "neutral" | "ok" | "gate" =>
  outcome === "done" ? "ok" : outcome === "error" || outcome === "stopped" ? "gate" : "neutral"

/** The activity row (if any) captured for a given run-log stage section. */
const activityFor = (
  activity: readonly StageActivity[] | undefined,
  sec: { stage: string; iteration: number; lens?: string },
): StageActivity | undefined =>
  activity?.find((a) => a.stage === sec.stage && a.iteration === sec.iteration && a.lens === sec.lens)

/** Compact "what this stage did" line — tool call counts and files written. */
const StageActivityLine = ({ activity }: { activity: StageActivity }) => (
  <div className="stage-activity">
    {activity.tools.map((t) => (
      <Chip key={t.tool}>
        {t.tool} ×{t.count}
        {t.errors > 0 ? ` · ${t.errors} err` : ""}
      </Chip>
    ))}
    {activity.files && activity.files.length > 0 && (
      <span className="stage-files muted">
        wrote {activity.files.length === 1 ? activity.files[0] : `${activity.files.length} files: ${activity.files.join(", ")}`}
      </span>
    )}
  </div>
)

const RunDetail = ({ id }: { id: string }) => {
  const { repoId } = useRepo()
  const { data: detail, error } = useJson<RunDetailResponse>(repoPath(`/api/runs/${encodeURIComponent(id)}`, repoId), [
    id,
    repoId,
  ])

  if (error) return <div className="error-banner">{error}</div>
  if (!detail) return <div className="placeholder">Loading run…</div>

  return (
    <div className="run-detail">
      {detail.snapshot && (
        <div className="summary-chips">
          <Chip gate>
            snapshot: parked at <strong>{detail.snapshot.stage}</strong> (iteration {detail.snapshot.iteration + 1})
            {detail.snapshot.branch ? ` on ${detail.snapshot.branch}` : ""}
          </Chip>
          {detail.snapshot.artifactStages && detail.snapshot.artifactStages.length > 0 && (
            <Chip>
              a resume would carry: <strong>{detail.snapshot.artifactStages.join(", ")}</strong>
            </Chip>
          )}
        </div>
      )}
      {detail.log.summaries.map((s, i) => (
        <div key={i} className="run-summary">
          <div className="run-summary-head">
            <Badge tone={outcomeTone(s.outcome)}>{s.outcome}</Badge>
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
                      {r.verdict ? <Badge tone={r.verdict === "PASS" ? "ok" : "gate"}>{r.verdict}</Badge> : "—"}
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
      {detail.log.sections.map((sec, i) => {
        const activity = activityFor(detail.activity, sec)
        return (
          <details key={i} className="stage-section">
            <summary>
              {sec.lens ? `${sec.stage} (${sec.lens})` : sec.stage} · iteration {sec.iteration}{" "}
              <span className="muted">{sec.at}</span>
            </summary>
            {activity && <StageActivityLine activity={activity} />}
            <pre>{sec.body}</pre>
          </details>
        )
      })}
      {detail.log.sections.length === 0 && detail.log.summaries.length === 0 && (
        <div className="placeholder">Run log is empty.</div>
      )}
      <TokenPanel runId={id} />
    </div>
  )
}

export const Runs = () => {
  const [selected, setSelected] = useState<string | null>(null)
  const { versions } = useEvents()
  const { repoId } = useRepo()
  // Refetch on `versions.active` too: the live `.stage.json` marker flips a
  // run's `active` flag when a loop starts/ends, without touching any run `.md`.
  const { data, error } = useJson<RunsResponse>(repoPath("/api/runs", repoId), [versions.run, versions.active, repoId])

  // Collapse the open run whenever the list refreshes or the repo changes — the
  // selected id may no longer exist.
  useEffect(() => setSelected(null), [versions.run, repoId])

  if (error) return <div className="error-banner">Could not load run history: {error}</div>
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
            {r.active ? (
              <Badge tone="live">in progress</Badge>
            ) : (
              r.outcome && <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
            )}
            {r.detail && <span className="muted">{r.detail}</span>}
            {r.at && <span className="muted">{new Date(r.at).toLocaleString()}</span>}
          </button>
        ))}
      </div>
      {selected && <RunDetail id={selected} />}
    </div>
  )
}
