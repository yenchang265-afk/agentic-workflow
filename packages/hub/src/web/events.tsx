import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { HubEvent } from "../shared/api.js"

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
  /** `.agentic-loop.json` changed — from the hub's own save or a hand-edit. */
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

const initial: EventVersions = { backlog: 0, run: 0, active: 0, tokens: 0, gate: 0, config: 0, repos: 0 }

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

  useEffect(() => {
    const source = new EventSource("/api/events")
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false) // EventSource auto-reconnects
    source.onmessage = (msg) => {
      let event: HubEvent
      try {
        event = JSON.parse(msg.data as string) as HubEvent
      } catch {
        return
      }
      setVersions((v) => ({ ...v, [event.type]: v[event.type] + 1 }))
      if (event.type === "gate" && notifRef.current === "granted") {
        new Notification("agentic-loop: task parked for your review", {
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
