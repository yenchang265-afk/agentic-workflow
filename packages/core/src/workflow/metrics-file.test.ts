import assert from "node:assert/strict"
import { test } from "node:test"
import { appendRunMetrics, parseRunMetrics, upsertRunMetrics, type RunEntry } from "./metrics-file.js"

const entry: RunEntry = {
  endedAt: "2026-07-06T10:00:00.000Z",
  outcome: "done",
  detail: "review passed",
  host: "opencode",
  sessionID: "ses_123",
  samples: [
    {
      stage: "build",
      iteration: 0,
      ms: 20_000,
      startedAt: "2026-07-06T09:59:40.000Z",
      tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 5000, cacheWrite: 100 },
      cost: 0.1234,
      model: "claude-sonnet-5",
    },
    { stage: "verify", iteration: 0, ms: 16_000, verdict: "PASS" },
  ],
}

test("appendRunMetrics starts a fresh document and round-trips through parse", () => {
  const raw = appendRunMetrics(null, entry)
  const parsed = parseRunMetrics(raw)
  assert.equal(parsed?.version, 1)
  assert.equal(parsed?.runs.length, 1)
  assert.deepEqual(parsed?.runs[0], entry)
})

test("appendRunMetrics appends to existing content and recovers from corrupt files", () => {
  const first = appendRunMetrics(null, entry)
  const second = appendRunMetrics(first, { ...entry, outcome: "error", detail: "boom" })
  const parsed = parseRunMetrics(second)
  assert.equal(parsed?.runs.length, 2)
  assert.equal(parsed?.runs[1]?.outcome, "error")

  const recovered = parseRunMetrics(appendRunMetrics("{not json", entry))
  assert.equal(recovered?.runs.length, 1)
})

test("parseRunMetrics fails closed on invalid shape or version", () => {
  assert.equal(parseRunMetrics("null"), null)
  assert.equal(parseRunMetrics('{"version":2,"runs":[]}'), null)
  assert.equal(parseRunMetrics('{"version":1,"runs":[{"bad":true}]}'), null)
  assert.equal(parseRunMetrics("not json at all"), null)
})

test("upsertRunMetrics replaces a trailing open entry across the live flush cycle", () => {
  const open1: RunEntry = { ...entry, endedAt: "t1", outcome: undefined, open: true, samples: entry.samples.slice(0, 1) }
  const open2: RunEntry = { ...entry, endedAt: "t2", outcome: undefined, open: true, samples: entry.samples }
  const final: RunEntry = { ...entry, endedAt: "t3", outcome: "done", open: undefined }

  // open → open: the second flush replaces the first (one entry, still open, latest samples).
  const afterFlush = upsertRunMetrics(upsertRunMetrics(null, open1), open2)
  const flushed = parseRunMetrics(afterFlush)
  assert.equal(flushed?.runs.length, 1)
  assert.equal(flushed?.runs[0]?.open, true)
  assert.equal(flushed?.runs[0]?.samples.length, 2)

  // open → final: the terminal write replaces the open entry (one entry, no open flag).
  const afterFinal = parseRunMetrics(upsertRunMetrics(afterFlush, final))
  assert.equal(afterFinal?.runs.length, 1)
  assert.equal(afterFinal?.runs[0]?.open, undefined)
  assert.equal(afterFinal?.runs[0]?.outcome, "done")
})

test("upsertRunMetrics appends when the last entry is already finalized (re-run of a task)", () => {
  const final1 = upsertRunMetrics(null, entry) // no open flag
  const openNext: RunEntry = { ...entry, endedAt: "t9", outcome: undefined, open: true }
  const parsed = parseRunMetrics(upsertRunMetrics(final1, openNext))
  assert.equal(parsed?.runs.length, 2) // prior finalized run preserved; new open run appended
  assert.equal(parsed?.runs[0]?.open, undefined)
  assert.equal(parsed?.runs[1]?.open, true)
})

test("claude-host entries carry no tokens and no sessionID", () => {
  const claudeEntry: RunEntry = {
    endedAt: "2026-07-06T10:00:00.000Z",
    outcome: "done",
    detail: "",
    host: "claude",
    samples: [{ stage: "verify", iteration: 0, ms: 1000, verdict: "PASS" }],
  }
  const parsed = parseRunMetrics(appendRunMetrics(null, claudeEntry))
  assert.equal(parsed?.runs[0]?.sessionID, undefined)
  assert.equal(parsed?.runs[0]?.samples[0]?.tokens, undefined)
})
