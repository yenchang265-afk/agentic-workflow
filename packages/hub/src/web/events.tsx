import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { HubEvent } from "../shared/api.js"
import { isForSelectedRepo } from "./selectedrepo.js"

/**
 * One EventSource for the whole app. Components read per-type version
 * counters and refetch when theirs bumps; gate events additionally fire a
 * browser Notification once the user has armed the bell.
 */

export interface EventVersions {
  readonly backlog: number
  readonly run: number
  readonly active: number
  readonly tokens: number
  readonly gate: number
  /** `runs/events.jsonl` grew — SchedulerPanel refetches /api/scheduler. */
  readonly sched: number
  /** `.agentic-workflow.json` changed — from the hub's own save or a hand-edit. */
  readonly config: number
  /** The monitored-repo set grew — RepoProvider refetches /api/repos. */
  readonly repos: number
}

interface EventsValue {
  readonly versions: EventVersions
  readonly connected: boolean
  readonly notifications: NotificationPermission | "unsupported"
  readonly requestNotifications: () => void
}

const initial: EventVersions = { backlog: 0, run: 0, active: 0, tokens: 0, gate: 0, sched: 0, config: 0, repos: 0 }

/**
 * Every counter forward one — "we were disconnected, assume all of it moved".
 *
 * Derived from the object's own keys rather than an enumerated literal, so a
 * counter added later is bumped without anyone remembering to come back here.
 * The enumerated version silently stopped covering `sched` the moment it was
 * added, which would have left the scheduler panel showing pre-outage data
 * after every reconnect — the exact failure this function exists to prevent.
 */
const bumpAll = (v: EventVersions): EventVersions =>
  Object.fromEntries(Object.entries(v).map(([key, n]) => [key, n + 1])) as unknown as EventVersions

const EventsContext = createContext<EventsValue>({
  versions: initial,
  connected: false,
  notifications: "unsupported",
  requestNotifications: () => {},
})

export const EventsProvider = ({ children }: { children: ReactNode }) => {
  const [versions, setVersions] = useState<EventVersions>(initial)
  const [connected, setConnected] = useState(false)
  const [notifications, setNotifications] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  )
  const notifRef = useRef(notifications)
  notifRef.current = notifications
  // Whether the stream has been down since the last successful open. Starts
  // false so the FIRST connect doesn't fire a redundant refetch of data the
  // panels are already loading.
  const droppedRef = useRef(false)

  useEffect(() => {
    const source = new EventSource("/api/events")
    source.onopen = () => {
      setConnected(true)
      if (!droppedRef.current) return
      droppedRef.current = false
      // The stream carries no backfill, so everything that happened while it
      // was down is simply missing — and the UI went on rendering the last
      // pre-outage data as though it were live. Bumping every counter makes
      // each panel's existing dep list refetch, which is exactly the claim
      // "reconnected" should imply.
      setVersions(bumpAll)
    }
    source.onerror = () => {
      setConnected(false) // EventSource auto-reconnects
      droppedRef.current = true
    }
    source.onmessage = (msg) => {
      let event: HubEvent
      try {
        event = JSON.parse(msg.data as string) as HubEvent
      } catch {
        return
      }
      // Events are tagged with their repo. Bumping a version for a repo the
      // user isn't looking at made a busy loop in repo B refetch the whole
      // board, run list and metrics of repo A, continuously. `repos` is exempt:
      // it announces a NEW repo, so it is about the set, not about a member.
      if (event.type === "repos" || isForSelectedRepo(event.repo)) {
        setVersions((v) => ({ ...v, [event.type]: v[event.type] + 1 }))
      }
      // The notification is deliberately NOT repo-filtered: the bell is global,
      // and a gate you cannot see is the one most worth being told about.
      if (event.type === "gate" && notifRef.current === "granted") {
        new Notification("agentic-workflow: task parked for your review", {
          body: `[${event.repo}] ${event.taskId} → ${event.toStatus} — approve or replan when ready`,
          tag: `gate-${event.repo}-${event.taskId}`,
        })
      }
    }
    return () => source.close()
  }, [])

  const requestNotifications = (): void => {
    if (typeof Notification === "undefined") return
    void Notification.requestPermission().then(setNotifications)
  }

  return (
    <EventsContext.Provider value={{ versions, connected, notifications, requestNotifications }}>
      {children}
    </EventsContext.Provider>
  )
}

export const useEvents = (): EventsValue => useContext(EventsContext)
