import assert from "node:assert/strict"
import { test } from "node:test"
import type { ParsedRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { ReviewItem } from "../shared/api.js"
import { byWaiting, noteTimestamps, planExcerpt, runContext } from "./review.js"

test("noteTimestamps reads first and last stamped notes", () => {
  const notes = [
    { event: "created", at: "2026-07-01T10:00:00Z", by: "human" },
    { event: "approved", at: "2026-07-02T10:00:00Z", by: "human" },
    { event: "plan parked", at: "2026-07-03T10:00:00Z", by: "loop" },
  ]
  assert.deepEqual(noteTimestamps(notes), {
    createdAt: "2026-07-01T10:00:00Z",
    lastEventAt: "2026-07-03T10:00:00Z",
    lastEvent: "plan parked",
  })
})

test("noteTimestamps returns null rather than inventing an age", () => {
  // An unstamped trail means the age is UNKNOWN. Rendering that as 0 would
  // state a fact nobody recorded.
  assert.deepEqual(noteTimestamps([{ event: "created", at: "", by: "" }]), {
    createdAt: null,
    lastEventAt: null,
    lastEvent: null,
  })
  assert.deepEqual(noteTimestamps([]), { createdAt: null, lastEventAt: null, lastEvent: null })
})

test("noteTimestamps ignores unstamped notes when picking the latest", () => {
  const notes = [
    { event: "created", at: "2026-07-01T10:00:00Z", by: "h" },
    { event: "a stray blockquote", at: "", by: "" },
  ]
  assert.equal(noteTimestamps(notes).lastEvent, "created")
})

test("planExcerpt collapses whitespace and truncates on a word boundary", () => {
  assert.equal(planExcerpt(undefined), null)
  assert.equal(planExcerpt("   \n  "), null)
  assert.equal(planExcerpt("## Plan\n\nDo   the\tthing."), "## Plan Do the thing.")
  const long = `${"word ".repeat(200)}end`
  const cut = planExcerpt(long, 40)
  assert.ok(cut !== null && cut.length <= 41, `got ${String(cut?.length)}`)
  assert.ok(cut?.endsWith("…"))
  assert.ok(!cut?.includes("  "))
})

const summary = (over: Partial<ParsedRunLog["summaries"][number]>) => ({
  outcome: "done",
  at: "2026-07-03T10:00:00Z",
  rows: [],
  ...over,
})

test("runContext reports the stage of the last non-PASS verdict", () => {
  const log: ParsedRunLog = {
    sections: [],
    summaries: [
      summary({
        iterationsUsed: 3,
        cap: 8,
        rows: [
          { stage: "build", iteration: 1, duration: "1m", seconds: 60, extra: {} },
          { stage: "verify", iteration: 1, verdict: "FAIL", duration: "1m", seconds: 60, extra: {} },
          { stage: "review", iteration: 2, verdict: "PASS", duration: "1m", seconds: 60, extra: {} },
        ],
      }),
    ],
  }
  assert.deepEqual(runContext("fix-pagination", log), {
    id: "fix-pagination",
    outcome: "done",
    at: "2026-07-03T10:00:00Z",
    iterationsUsed: 3,
    cap: 8,
    failedStage: "verify",
    lastVerdict: "PASS",
  })
})

test("runContext keeps an unrecorded cap null rather than zero", () => {
  const log: ParsedRunLog = { sections: [], summaries: [summary({})] }
  const ctx = runContext("x", log)
  assert.equal(ctx?.iterationsUsed, null)
  assert.equal(ctx?.cap, null)
  assert.equal(ctx?.failedStage, null)
  assert.equal(ctx?.lastVerdict, null)
})

test("runContext uses the newest pass — one log accumulates several", () => {
  const log: ParsedRunLog = {
    sections: [],
    summaries: [summary({ outcome: "done", at: "2026-07-01T00:00:00Z" }), summary({ outcome: "error", at: "2026-07-05T00:00:00Z" })],
  }
  assert.equal(runContext("x", log)?.outcome, "error")
})

test("runContext returns null for a log with no summaries", () => {
  assert.equal(runContext("x", { sections: [], summaries: [] }), null)
})

const item = (id: string, lastEventAt: string | null): ReviewItem => ({
  kind: "engineering",
  status: "plan-review",
  card: { id, shortId: id, title: id, priority: 0, labels: [], acceptance: [], paired: false, hasPlan: true },
  createdAt: null,
  lastEventAt,
  lastEvent: null,
  planExcerpt: null,
  branch: null,
  diffstat: null,
  lastRun: null,
  claimed: false,
})

test("byWaiting puts the longest-waiting first and unknown ages last", () => {
  const sorted = [item("b", "2026-07-05T00:00:00Z"), item("a", null), item("c", "2026-07-01T00:00:00Z")].sort(byWaiting)
  assert.deepEqual(
    sorted.map((i) => i.card.id),
    ["c", "b", "a"],
  )
})

test("byWaiting is stable on ties, so the queue doesn't reshuffle under the cursor", () => {
  const same = "2026-07-05T00:00:00Z"
  const sorted = [item("z", same), item("a", same)].sort(byWaiting)
  assert.deepEqual(
    sorted.map((i) => i.card.id),
    ["a", "z"],
  )
})
