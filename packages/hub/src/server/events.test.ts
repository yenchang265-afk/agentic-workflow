import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { HubEvent } from "../shared/api.js"
import { makeEventHub } from "./events.js"

/**
 * The SSE fan-out must survive a dead client: a write that throws (socket gone)
 * prunes that client rather than aborting the broadcast to everyone after it,
 * and a response 'error' event must not go unhandled (it would crash the process).
 */

/** A fake SSE client. `writable: false` makes every write throw, like a dead socket. */
const fakeClient = (writable = true) => {
  const req = new EventEmitter() as unknown as IncomingMessage
  const writes: string[] = []
  const res = Object.assign(new EventEmitter(), {
    writeHead: () => res,
    write: (chunk: string) => {
      if (!writable) throw new Error("EPIPE: socket closed")
      writes.push(chunk)
      return true
    },
    end: () => {},
  }) as unknown as ServerResponse & { readonly writes?: string[] }
  return { req, res, writes }
}

test("broadcast delivers to a live client", () => {
  const hub = makeEventHub()
  const a = fakeClient()
  hub.handle(a.req, a.res)
  const events: HubEvent[] = [{ type: "backlog" } as HubEvent]
  hub.broadcast(events)
  assert.ok(a.writes.some((w) => w.includes('"type":"backlog"')))
  hub.close()
})

test("a client whose write throws is pruned and does not starve later clients", () => {
  const hub = makeEventHub()
  const dead = fakeClient(false) // every write throws
  const live = fakeClient(true)
  hub.handle(dead.req, dead.res)
  hub.handle(live.req, live.res)
  // Must not throw even though `dead` throws mid-loop, and `live` still receives it.
  assert.doesNotThrow(() => hub.broadcast([{ type: "run" } as HubEvent]))
  assert.ok(live.writes.some((w) => w.includes('"type":"run"')))
  // The dead client was pruned: a second broadcast reaches only the live one.
  live.writes.length = 0
  hub.broadcast([{ type: "active" } as HubEvent])
  assert.ok(live.writes.some((w) => w.includes('"type":"active"')))
  hub.close()
})

test("the client set is capped — the oldest connection is evicted, never unbounded growth", () => {
  const hub = makeEventHub()
  const first = fakeClient()
  hub.handle(first.req, first.res)
  const rest = Array.from({ length: 32 }, () => fakeClient())
  for (const c of rest) hub.handle(c.req, c.res)
  first.writes.length = 0
  hub.broadcast([{ type: "run" } as HubEvent])
  assert.ok(!first.writes.some((w) => w.includes('"type":"run"')), "the oldest client was evicted")
  assert.ok(
    rest.every((c) => c.writes.some((w) => w.includes('"type":"run"'))),
    "every newer client still receives broadcasts",
  )
  hub.close()
})

test("a response 'error' event prunes the client without throwing", () => {
  const hub = makeEventHub()
  const c = fakeClient()
  hub.handle(c.req, c.res)
  // An unhandled 'error' on an EventEmitter throws synchronously; the hub's
  // listener must absorb it.
  assert.doesNotThrow(() => c.res.emit("error", new Error("aborted")))
  hub.close()
})
