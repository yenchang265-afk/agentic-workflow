import { isEpicType } from "@agentic-workflow/core/task/schema"
import type { ActiveResponse, BacklogResponse, KindBoardInfo, StageMarker, TaskCard } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { timeAgo } from "../metrics/format.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { buildHash, withQuery } from "../route.js"
import { Link, navigate, useRoute } from "../routing.js"
import { useEffect, useState } from "react"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Card } from "../ui/Card.js"
import { Chip } from "../ui/Chip.js"
import { DoctorPanel } from "./DoctorPanel.js"
import { GateActions } from "./GateActions.js"
import { TaskDrawer } from "./TaskDrawer.js"
import { parseTaskParam, taskParam } from "./taskparam.js"

/**
 * The backlog board for one workflow kind: one column per manifest status, task
 * cards from frontmatter, gate columns (park/done targets from the manifest's
 * transitions) highlighted — those are where the loop is waiting on a human.
 * Engineering-only lifecycle chips render when the server sends its summary.
 */

/**
 * The claimed badge with a ticking age against core's stale floor. Past the
 * floor the tone stays gate but the text says so — the sweep MAY release it
 * (a configured stage timeout extends the window), so "stale?" not "stale".
 */
const ClaimedBadge = ({ claimedAt, staleMinutes }: { claimedAt?: string; staleMinutes?: number }) => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!claimedAt) return <Badge tone="gate">claimed</Badge>
  const ageMinutes = (now - Date.parse(claimedAt)) / 60_000
  const maybeStale = staleMinutes !== undefined && ageMinutes > staleMinutes
  return (
    <Badge
      tone="gate"
      title={`claimed ${new Date(claimedAt).toLocaleString()}${
        maybeStale ? ` — older than the ${staleMinutes}m stale floor; the next sweep may release it` : ""
      }`}
    >
      claimed {timeAgo(claimedAt, now).replace(" ago", "")}
      {maybeStale ? " · stale?" : ""}
    </Badge>
  )
}

const TaskCardView = ({
  task,
  gated,
  claimed,
  claimedAt,
  staleMinutes,
  planRequested,
  status,
  kind,
  stage,
  onOpen,
}: {
  task: TaskCard
  gated: boolean
  claimed: boolean
  claimedAt?: string
  staleMinutes?: number
  /** A human asked for this queued task to be planned next. Not a claim — nothing is running. */
  planRequested: boolean
  status: string
  kind: string
  /** The live stage marker, already confirmed to belong to this task. */
  stage: StageMarker | null
  onOpen: () => void
}) => (
  <Card gated={gated} title={task.acceptance.join("\n")}>
    {/* A button rather than a click handler on the card: gate buttons and a
        confirm dialog already live inside it, and this stays keyboard-reachable. */}
    <button type="button" className="card-title card-open" onClick={onOpen}>
      {task.title}
    </button>
    <div className="card-meta">
      <Badge title={task.id}>{task.shortId}</Badge>
      {task.type && <Badge>{task.type}</Badge>}
      {task.hasPlan && <Badge tone="ok">plan</Badge>}
      {/* Neutral tone on purpose: `gate` already means "waiting on you" and
          `live` means a stage is running. A request is neither — it is an ask
          nothing has acted on yet. */}
      {planRequested && (
        <Badge title="plan requested — the next claim or watch tick plans this before other queued tasks; nothing is running yet">
          plan requested
        </Badge>
      )}
      {claimed && <ClaimedBadge claimedAt={claimedAt} staleMinutes={staleMinutes} />}
      {gated && <Badge tone="gate">awaiting you</Badge>}
      {stage && (
        <Badge tone="live" title="current sub-stage — retries on VERIFY/REVIEW fail re-run BUILD">
          {stage.stage}
          {stage.iteration != null ? ` · iter ${stage.iteration}` : ""}
        </Badge>
      )}
      {task.labels.map((l) => (
        <Badge key={l}>{l}</Badge>
      ))}
    </div>
    {/* An epic only orders its child slices — approving it would have the loop
        plan the tracking file itself, which core refuses. Don't offer it. */}
    {!isEpicType(task.type) && (
      <GateActions task={task} status={status} kind={kind} claimed={claimed} planRequested={planRequested} />
    )}
  </Card>
)

export const Board = ({ info }: { info: KindBoardInfo }) => {
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const [doctorOpen, setDoctorOpen] = useState(false)
  const route = useRoute()
  // The open task lives in the URL as `?task=<status>/<id>`, so a drawer can be
  // linked to (a gate notification can point straight at the decision) and Back
  // closes it rather than leaving the app.
  const openTask = parseTaskParam(route.query.task)
  const closeTask = (): void => navigate(withQuery(route, { task: undefined }))
  const { data, error, refetch } = useResource<BacklogResponse>(
    repoPath(`/api/backlog?kind=${encodeURIComponent(info.kind)}`, repoId),
    [versions.backlog, versions.gate, repoId, info.kind],
  )
  const { data: active } = useResource<ActiveResponse>(repoPath("/api/active", repoId), [versions.active, repoId])
  // Only the Claude host writes this marker (see StageMarker), and only one loop
  // runs at a time, so at most one card across every board can match it.
  const liveStage = active?.stage && active.stage.kind === info.kind ? active.stage : null

  if (error)
    return (
      <div className="error-banner">
        Could not load backlog: {error} <Button onClick={refetch}>Retry</Button>
      </div>
    )
  if (!data) return <div className="placeholder">Loading backlog…</div>

  const { summary } = data
  // Tracking epics are never approvable (no GateActions render for them, see
  // TaskCardView), so they must not inflate "N awaiting your review".
  const gateCount = data.gateStatuses.reduce(
    (n, status) => n + (data.tasks[status]?.filter((t) => !isEpicType(t.type)).length ?? 0),
    0,
  )
  const claimed = new Set(data.claimedIds)
  const planRequested = new Set(data.planRequestedIds)

  return (
    <div>
      <div className="summary-chips">
        {/* A control, not a caption. This read "3 awaiting your review" as
            static text, and then left you to find those three by eye across a
            horizontally scrolling seven-column board. */}
        {gateCount > 0 && (
          <Link to={buildHash({ screen: "review", query: route.query })} className="chip-link">
            <Chip gate>
              <strong>{gateCount}</strong> awaiting your review →
            </Chip>
          </Link>
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
        {data.anomalies && (
          <button type="button" className="chip-button" onClick={() => setDoctorOpen((o) => !o)}>
            <Chip gate>backlog anomalies — {doctorOpen ? "hide" : "run"} doctor</Chip>
          </button>
        )}
      </div>
      {doctorOpen && <DoctorPanel />}
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
                <TaskCardView
                  key={t.id}
                  task={t}
                  gated={gate && !isEpicType(t.type)}
                  claimed={claimed.has(t.id)}
                  claimedAt={data.claimStamps?.[t.id]}
                  staleMinutes={data.staleClaimMinutes}
                  planRequested={planRequested.has(t.id)}
                  status={status}
                  kind={info.kind}
                  stage={liveStage?.taskId === t.id ? liveStage : null}
                  onOpen={() => navigate(withQuery(route, { task: taskParam(status, t.id) }))}
                />
              ))}
            </div>
          )
        })}
      </div>
      {openTask && (
        <TaskDrawer
          key={`${openTask.status}/${openTask.id}`}
          id={openTask.id}
          status={openTask.status}
          kind={info.kind}
          claimed={claimed.has(openTask.id)}
          planRequested={planRequested.has(openTask.id)}
          onClose={closeTask}
        />
      )}
    </div>
  )
}
