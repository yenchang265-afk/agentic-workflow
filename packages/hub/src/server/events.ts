import type { IncomingMessage, ServerResponse } from "node:http"
import type { HubEvent } from "../shared/api.js"

/**
 * SSE fan-out: `/api/events` clients get every watcher diff as one
 * `data: <json HubEvent>` message. No replay — clients refetch what they
 * render on connect; a comment heartbeat keeps proxies from idling out.
 */

export interface EventHub {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void
  readonly broadcast: (events: readonly HubEvent[]) => void
  readonly close: () => void
}

export const makeEventHub = (heartbeatMs = 25_000): EventHub => {
  const clients = new Set<ServerResponse>()

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n")
  }, heartbeatMs)
  heartbeat.unref()

  return {
    handle(req, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      res.write(": connected\n\n")
      clients.add(res)
      req.on("close", () => clients.delete(res))
    },
    broadcast(events) {
      if (events.length === 0) return
      const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
      for (const res of clients) res.write(payload)
    },
    close() {
      clearInterval(heartbeat)
      for (const res of clients) res.end()
      clients.clear()
    },
  }
}
