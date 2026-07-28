import { useState } from "react"
import type { SchedulerEventsResponse, SchedulerEventView } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { Badge } from "../ui/Badge.js"

/**
 * The scheduler event feed: what claim/watch actually DID — claims, deduped
 * skip-sets, releases, terminals, and the stale claim/lease takeovers no
 * point-in-time state file shows. Collapsed by default: it is forensics, not
 * a dashboard headline.
 */

const tone = (e: SchedulerEventView): "ok" | "neutral" | "gate" =>
  e.type === "claim"
    ? "ok"
    : e.type === "claim-takeover" || e.type === "lease-takeover" || (e.type === "skip" && (e.reasons ?? []).some((r) => r.actionable))
      ? "gate"
      : "neutral"

const describe = (e: SchedulerEventView): string => {
  switch (e.type) {
    case "claim":
      return `claimed ${e.id} (${e.kind})`
    case "release":
      return `released ${e.id} (${e.kind}) — died before real work started`
    case "terminal":
      return `${e.id} (${e.kind}) → ${e.outcome}${e.retryable ? " (retryable)" : ""}`
    case "skip":
      return `skipped: ${(e.reasons ?? []).map((r) => r.message).join(" · ") || "no reason recorded"}`
    case "claim-takeover":
      return `stale claim on ${e.id} released${e.ageMinutes !== undefined ? ` after ${e.ageMinutes}m` : ""}`
    case "lease-takeover":
      return `watch lease taken over${e.oldPid !== undefined ? ` from pid ${e.oldPid}${e.oldHost ? ` (${e.oldHost})` : ""}` : ""}`
    default:
      return e.type
  }
}

export const SchedulerPanel = () => {
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const [open, setOpen] = useState(false)
  const { data, error } = useResource<SchedulerEventsResponse>(repoPath("/api/scheduler", repoId), [versions.sched, repoId])

  if (error || !data || data.events.length === 0) return null

  return (
    <details className="stage-section" open={open} onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}>
      <summary>
        scheduler events ({data.events.length}){" "}
        {data.events.some((e) => tone(e) === "gate") && <Badge tone="gate">attention</Badge>}
      </summary>
      <div className="scheduler-events">
        {data.events.map((e, i) => (
          <div key={i} className="scheduler-event">
            <Badge tone={tone(e)}>{e.type}</Badge> <span>{describe(e)}</span>{" "}
            <span className="muted">
              {new Date(e.at).toLocaleString()} · {e.host} pid {e.pid}
            </span>
          </div>
        ))}
      </div>
    </details>
  )
}
