import { useEffect } from "react"
import type { RunDetailResponse, RunsResponse, RunSummaryRow, StageActivity } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { withQuery } from "../route.js"
import { Link, navigate, useRoute } from "../routing.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Chip } from "../ui/Chip.js"
import { alignRow, extraHeaders } from "./runtable.js"
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

/**
 * One summary's stage table. Headers are the union of every row's `extra` keys
 * and each cell is looked up by that key — see runtable.ts for why position
 * alignment was wrong.
 */
const StageTable = ({ rows }: { rows: readonly RunSummaryRow[] }) => {
  const headers = extraHeaders(rows)
  return (
    <table className="stage-table">
      <thead>
        <tr>
          <th>stage</th>
          <th>iter</th>
          <th>verdict</th>
          <th>wall-clock</th>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, j) => (
          <tr key={j}>
            <td>{r.lens ? `${r.stage} (${r.lens})` : r.stage}</td>
            <td>{r.iteration}</td>
            <td>{r.verdict ? <Badge tone={r.verdict === "PASS" ? "ok" : "gate"}>{r.verdict}</Badge> : "—"}</td>
            <td>{r.duration}</td>
            {alignRow(headers, r.extra).map((v, k) => (
              <td key={headers[k]}>{v}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const RunDetail = ({ id }: { id: string }) => {
  const { repoId } = useRepo()
  const { data: detail, error } = useResource<RunDetailResponse>(repoPath(`/api/runs/${encodeURIComponent(id)}`, repoId), [
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
          {s.rows.length > 0 && <StageTable rows={s.rows} />}
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
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const route = useRoute()
  // The open run lives in the URL, so a run log can be linked to — and Back
  // closes it instead of leaving the app.
  const selected = route.query.run ?? null
  // Refetch on `versions.active` too: the live `.stage.json` marker flips a
  // run's `active` flag when a loop starts/ends, without touching any run `.md`.
  const { data, error, refetch } = useResource<RunsResponse>(repoPath("/api/runs", repoId), [
    versions.run,
    versions.active,
    repoId,
  ])

  // A list refresh must not close the run you are reading. A live loop appends
  // to its run log at every stage, bumping `versions.run` — dropping the
  // selection there slammed the panel shut precisely while someone was watching
  // a run in progress. Clear it only once the id is genuinely gone (a repo
  // switch does that too, since ids don't cross repos). `replace` because the
  // user didn't ask for this move and shouldn't have to Back through it.
  useEffect(() => {
    if (data && selected !== null && !data.runs.some((r) => r.id === selected)) {
      navigate(withQuery(route, { run: undefined }), { replace: true })
    }
  }, [data, selected, route])

  if (error)
    return (
      <div className="error-banner">
        Could not load run history: {error} <Button onClick={refetch}>Retry</Button>
      </div>
    )
  if (!data) return null
  if (data.runs.length === 0) return <div className="placeholder">No run logs yet.</div>

  return (
    <div className="runs">
      <div className="runs-list">
        {data.runs.map((r) => (
          <Link
            key={r.id}
            to={withQuery(route, { run: selected === r.id ? undefined : r.id })}
            className={`run-row${selected === r.id ? " active" : ""}`}
          >
            <span className="run-id">{r.id}</span>
            {r.active ? (
              <Badge tone="live">in progress</Badge>
            ) : (
              r.outcome && <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>
            )}
            {r.detail && <span className="muted">{r.detail}</span>}
            {r.at && <span className="muted">{new Date(r.at).toLocaleString()}</span>}
          </Link>
        ))}
      </div>
      {selected && <RunDetail id={selected} />}
    </div>
  )
}
