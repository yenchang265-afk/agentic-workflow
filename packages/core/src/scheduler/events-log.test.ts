import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EVENTS_LOG_ROTATE_BYTES,
  formatEventLine,
  parseEventsLog,
  shouldRotate,
  skipSetKey,
  type SchedulerEvent,
} from "./events-log.js"

const claim: SchedulerEvent = { type: "claim", at: "2026-07-28T00:00:00.000Z", host: "opencode", pid: 1, kind: "engineering", id: "T-1" }
const skip: SchedulerEvent = {
  type: "skip",
  at: "2026-07-28T00:00:01.000Z",
  host: "claude",
  pid: 2,
  reasons: [{ message: "2 awaiting plan in queued/", actionable: true }],
}

test("events round-trip through format + parse", () => {
  const raw = [claim, skip].map(formatEventLine).join("\n")
  assert.deepEqual(parseEventsLog(raw), [claim, skip])
})

test("parseEventsLog is fail-open: torn and foreign lines drop, the rest survive", () => {
  const raw = [
    formatEventLine(claim),
    '{"type":"claim","at":"x"', // torn mid-write
    '{"not":"an event"}', // foreign JSON
    "plain garbage",
    "", // blank
    formatEventLine(skip),
  ].join("\n")
  assert.deepEqual(parseEventsLog(raw), [claim, skip])
})

test("skipSetKey is order-independent and distinguishes actionability", () => {
  const a = [
    { message: "a", actionable: false },
    { message: "b", actionable: true },
  ]
  const b = [
    { message: "b", actionable: true },
    { message: "a", actionable: false },
  ]
  assert.equal(skipSetKey(a), skipSetKey(b))
  assert.notEqual(skipSetKey([{ message: "a", actionable: false }]), skipSetKey([{ message: "a", actionable: true }]))
})

test("shouldRotate trips only past the threshold, never on an absent file", () => {
  assert.equal(shouldRotate(null), false)
  assert.equal(shouldRotate(0), false)
  assert.equal(shouldRotate(EVENTS_LOG_ROTATE_BYTES), false)
  assert.equal(shouldRotate(EVENTS_LOG_ROTATE_BYTES + 1), true)
})

test("takeover events parse with their optional fields absent", () => {
  const lease: SchedulerEvent = { type: "lease-takeover", at: "2026-07-28T00:00:02.000Z", host: "opencode", pid: 3 }
  const marker: SchedulerEvent = { type: "claim-takeover", at: "2026-07-28T00:00:03.000Z", host: "core", pid: 4, id: "T-2" }
  assert.deepEqual(parseEventsLog([lease, marker].map(formatEventLine).join("\n")), [lease, marker])
})
