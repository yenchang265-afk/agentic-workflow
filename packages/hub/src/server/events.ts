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

/** Concurrent SSE connections kept per hub. A local page opening EventSources
 *  in a loop (or leaking reconnects) must not grow the set without bound; the
 *  OLDEST connection is evicted — its EventSource auto-reconnects if still live. */
const MAX_SSE_CLIENTS = 32

export const makeEventHub = (heartbeatMs = 25_000): EventHub => {
  const clients = new Set<ServerResponse>()

  // Writing to a client whose socket has died throws (or emits 'error'); an
  // unhandled write throw would abort the fan-out mid-loop (starving later
  // clients) and an unhandled stream 'error' can crash the process. Prune the
  // dead client instead of propagating.
  const safeWrite = (res: ServerResponse, payload: string): void => {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) safeWrite(res, ": ping\n\n")
  }, heartbeatMs)
  heartbeat.unref()

  return {
    handle(req, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      // A client that aborts mid-write emits 'error' on the response stream;
      // without a listener that becomes an uncaught exception. Prune on both.
      res.on("error", () => clients.delete(res))
      if (clients.size >= MAX_SSE_CLIENTS) {
        const oldest = clients.values().next().value
        if (oldest) {
          clients.delete(oldest)
          try {
            oldest.end()
          } catch {
            /* already dead — eviction is what mattered */
          }
        }
      }
      clients.add(res)
      safeWrite(res, ": connected\n\n")
      req.on("close", () => clients.delete(res))
    },
    broadcast(events) {
      if (events.length === 0) return
      const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
      for (const res of clients) safeWrite(res, payload)
    },
    close() {
      clearInterval(heartbeat)
      for (const res of clients) res.end()
      clients.clear()
    },
  }
}
