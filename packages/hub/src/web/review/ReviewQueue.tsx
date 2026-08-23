import type { ReviewItem, ReviewResponse } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { GateActions } from "../monitor/GateActions.js"
import { TaskDrawer } from "../monitor/TaskDrawer.js"
import { parseTaskParam, taskParam } from "../monitor/taskparam.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { buildHash, withQuery } from "../route.js"
import { Link, navigate, useRoute } from "../routing.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { StatusMessage } from "../ui/StatusMessage.js"
import { ageLabel, burnLabel, isCapTripped } from "./age.js"

/**
 * The review queue — what the hub is actually for.
 *
 * The hub's unique job is the human gate move; everything else it renders is
 * evidence for one. But the app was organised around its data sources, so the
 * decision was scattered: a card sitting in lifecycle order among seven
 * identical columns (with `in-review`, the ship gate, the first to scroll off
 * a 1440px screen), a drawer that could show you the plan but not act on it,
 * and a run history that could tell you what failed but was never linked to
 * the task it failed on.
 *
 * This is one row per waiting task, longest-waiting first, across every
 * enabled backlog kind, carrying what a decision needs: how long it has
 * waited, what the loop last did, which stage failed, how much of the
 * iteration budget it burned, and what the plan opens with.
 */

const RunContext = ({ item }: { item: ReviewItem }) => {
  const run = item.lastRun
  if (!run) return <span className="muted">no run yet</span>
  const burn = burnLabel(run.iterationsUsed, run.cap)
  return (
    <>
      <Badge tone={run.outcome === "done" ? "ok" : run.outcome === "stopped" ? "neutral" : "gate"}>{run.outcome}</Badge>
      {run.failedStage && (
        <span className="review__failed" title="The last stage that did not pass">
          failed at <strong>{run.failedStage}</strong>
        </span>
      )}
      {burn && (
        <span
          className={isCapTripped(run.iterationsUsed, run.cap) ? "review__burn review__burn--tripped" : "review__burn"}
          title={
            isCapTripped(run.iterationsUsed, run.cap)
              ? "Spent its whole iteration allowance — the loop stopped rather than converged"
              : "Iterations used of the cap"
          }
        >
          {burn}
        </span>
      )}
      {/* A run's id IS its task's id, so the evidence is one click away — a
          link that could always have existed and never did. */}
      <Link to={buildHash({ screen: "monitor", params: [item.kind], query: { run: run.id } })} className="review__runlink">
        run log
      </Link>
    </>
  )
}

const ReviewRow = ({ item, now }: { item: ReviewItem; now: number }) => {
  const route = useRoute()
  const age = ageLabel(item.lastEventAt, now)
  return (
    <li className={`review__item${item.claimed ? " review__item--claimed" : ""}`}>
      <div className="review__head">
        <button
          type="button"
          className="review__title"
          onClick={() => navigate(withQuery(route, { task: taskParam(item.status, item.card.id) }))}
        >
          {item.card.title}
        </button>
        <Badge title={item.card.id}>{item.card.shortId}</Badge>
        <Badge>{item.status}</Badge>
        <Badge>{item.kind}</Badge>
        {item.card.type && <Badge>{item.card.type}</Badge>}
        {item.card.priority !== 0 && <Badge title="Selection order — lower runs first">p{item.card.priority}</Badge>}
        {/* Null age is stated, not hidden: "we don't know" is a different fact
            from "it just arrived", and only one of them is true. */}
        <span className="review__age" title={item.lastEventAt ?? "no timestamped audit note"}>
          {age === null ? "age unknown" : `waiting ${age}`}
        </span>
      </div>

      <div className="review__meta">
        <RunContext item={item} />
        {(item.branch !== null || item.diffstat !== null) && (
          <span className="muted review__diff">
            {item.diffstat ?? "diff"}
            {item.branch !== null ? ` on ${item.branch}` : ""}
          </span>
        )}
        {item.lastEvent && <span className="muted review__event">{item.lastEvent}</span>}
        {item.card.acceptance.length > 0 && (
          <span className="muted">
            {item.card.acceptance.length} acceptance {item.card.acceptance.length === 1 ? "criterion" : "criteria"}
          </span>
        )}
        {item.card.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </div>

      {item.planExcerpt && <p className="review__plan">{item.planExcerpt}</p>}

      {item.claimed && (
        <StatusMessage tone="info">
          A loop is driving this task right now — gate moves are refused until it parks or is stopped.
        </StatusMessage>
      )}

      <GateActions task={item.card} status={item.status} kind={item.kind} claimed={item.claimed} />
    </li>
  )
}

export const ReviewQueue = () => {
  const { repoId } = useRepo()
  const { versions } = useEvents()
  const route = useRoute()
  // The drawer is driven by the same `?task=` param the board uses, so a task
  // opens the same way — and links the same way — from either surface.
  const openTask = parseTaskParam(route.query.task)
  const { data, error, loading, refetch } = useResource<ReviewResponse>(repoPath("/api/review", repoId), [
    versions.backlog,
    versions.gate,
    versions.run,
    repoId,
  ])

  // One instant for the whole list, so ages can't disagree between rows.
  const now = Date.now()

  if (error)
    return (
      <StatusMessage tone="error" onRetry={refetch}>
        Could not load the review queue: {error}
      </StatusMessage>
    )
  if (loading || !data) return <div className="placeholder">Loading review queue…</div>

  if (data.items.length === 0)
    return (
      <div className="review review--empty">
        <h2 className="section-title">Nothing waiting on you</h2>
        <p className="muted">
          No task is parked at a gate across {data.kinds.length === 1 ? "this kind" : `${data.kinds.length} kinds`} (
          {data.kinds.join(", ")}). The board shows everything else.
        </p>
        <Button onClick={() => navigate(buildHash({ screen: "monitor", query: { repo: repoId ?? "" } }))}>
          Open the board
        </Button>
      </div>
    )

  return (
    <div className="review">
      <div className="summary-chips">
        <span className="review__count">
          <strong>{data.items.length}</strong> waiting on you
        </span>
        <span className="muted">longest first</span>
      </div>
      <ul className="review__list">
        {data.items.map((item) => (
          <ReviewRow key={`${item.kind}/${item.status}/${item.card.id}`} item={item} now={now} />
        ))}
      </ul>
      {openTask && (
        <TaskDrawer
          key={`${openTask.status}/${openTask.id}`}
          id={openTask.id}
          status={openTask.status}
          kind={data.items.find((i) => i.card.id === openTask.id)?.kind ?? data.kinds[0] ?? "engineering"}
          claimed={data.items.find((i) => i.card.id === openTask.id)?.claimed ?? false}
          // The review queue only ever lists gate statuses, never queued/, so no
          // task reachable from here can carry a plan request.
          planRequested={false}
          onClose={() => navigate(withQuery(route, { task: undefined }))}
        />
      )}
    </div>
  )
}
