import assert from "node:assert/strict"
import { test } from "node:test"
import { renderRunSummary, type StageSample } from "./metrics.js"
import { parseDuration, parseRunLog } from "./runlog.js"

test("parseDuration inverts formatDuration shapes", () => {
  assert.equal(parseDuration("45s"), 45)
  assert.equal(parseDuration("2m 41s"), 161)
  assert.equal(parseDuration("1h 03m"), 3780)
  assert.equal(parseDuration(""), 0)
})

test("parseRunLog round-trips renderRunSummary output", () => {
  const samples: StageSample[] = [
    { stage: "build", iteration: 0, ms: 20_000 },
    { stage: "verify", iteration: 0, ms: 16_000, verdict: "PASS" },
    { stage: "review", iteration: 0, ms: 17_000, verdict: "PASS", lens: "security" },
  ]
  const stamp = "2026-07-05T13:16:25.138Z"
  const log = `\n## run · done\n\n${renderRunSummary(samples, "done", "review passed", 3, stamp)}\n`
  const parsed = parseRunLog(log)
  assert.equal(parsed.summaries.length, 1)
  const summary = parsed.summaries[0]
  assert.equal(summary?.outcome, "done")
  assert.equal(summary?.detail, "review passed")
  assert.equal(summary?.at, stamp)
  assert.equal(summary?.iterationsUsed, 1)
  assert.equal(summary?.cap, 3)
  assert.equal(summary?.rows.length, 3)
  assert.deepEqual(summary?.rows[0], {
    stage: "build",
    iteration: 1,
    duration: "20s",
    seconds: 20,
    extra: {},
  })
  assert.equal(summary?.rows[1]?.verdict, "PASS")
  assert.equal(summary?.rows[2]?.lens, "security")
})

test("parseRunLog parses stage sections with and without lens", () => {
  const log = [
    "",
    "## plan · iteration 1 · 2026-07-05T13:14:00.000Z",
    "",
    "Wrote the plan.",
    "Multi-line output.",
    "",
    "## review (lens: security) · iteration 2 · 2026-07-05T13:15:00.000Z",
    "",
    "No injection found.",
  ].join("\n")
  const parsed = parseRunLog(log)
  assert.equal(parsed.sections.length, 2)
  assert.deepEqual(parsed.sections[0], {
    stage: "plan",
    iteration: 1,
    at: "2026-07-05T13:14:00.000Z",
    body: "Wrote the plan.\nMulti-line output.",
  })
  assert.equal(parsed.sections[1]?.lens, "security")
  assert.equal(parsed.sections[1]?.iteration, 2)
})

test("parseRunLog handles a real summaries-only log with multiple runs", () => {
  // Mirror of docs/tasks/runs/track-backlog-status-folders.md
  const log = [
    "",
    "## run · done",
    "",
    "## Run summary · done: plan parked for review · 2026-07-05T13:14:23.293Z",
    "",
    "| # | stage | iter | verdict | wall-clock |",
    "|---|-------|------|---------|------------|",
    "| 1 | plan | 1 | — | 31s |",
    "",
    "iterations used: 1/3 · total: 31s · outcome: done",
    "",
    "## run · done",
    "",
    "## Run summary · done: review passed · 2026-07-05T13:16:25.138Z",
    "",
    "| # | stage | iter | verdict | wall-clock |",
    "|---|-------|------|---------|------------|",
    "| 1 | build | 1 | — | 20s |",
    "| 2 | verify | 1 | PASS | 16s |",
    "| 3 | review | 1 | PASS | 17s |",
    "",
    "iterations used: 1/3 · total: 54s · outcome: done",
  ].join("\n")
  const parsed = parseRunLog(log)
  assert.equal(parsed.sections.length, 0)
  assert.equal(parsed.summaries.length, 2)
  assert.equal(parsed.summaries[0]?.detail, "plan parked for review")
  assert.equal(parsed.summaries[1]?.rows.length, 3)
  assert.equal(parsed.summaries[1]?.rows[1]?.verdict, "PASS")
})

test("parseRunLog carries unknown table columns in extra and skips unknown sections", () => {
  const log = [
    "## Run summary · done · 2026-07-05T13:16:25.138Z",
    "",
    "| # | stage | iter | verdict | wall-clock | tokens | cost |",
    "|---|-------|------|---------|------------|--------|------|",
    "| 1 | build | 1 | — | 20s | 12345 | $0.42 |",
    "",
    "iterations used: 1/3 · total: 20s · outcome: done",
    "",
    "## some future section · whatever",
    "",
    "ignored",
  ].join("\n")
  const parsed = parseRunLog(log)
  assert.equal(parsed.summaries[0]?.rows[0]?.extra["tokens"], "12345")
  assert.equal(parsed.summaries[0]?.rows[0]?.extra["cost"], "$0.42")
  assert.equal(parsed.sections.length, 0)
})

test("parseRunLog returns empty structure for empty or non-log markdown", () => {
  assert.deepEqual(parseRunLog(""), { sections: [], summaries: [] })
  assert.deepEqual(parseRunLog("# not a run log\n\nplain text"), { sections: [], summaries: [] })
})

test("parseRunLog round-trips a token-columned summary including footer cost", () => {
  const samples: StageSample[] = [
    {
      stage: "build",
      iteration: 0,
      ms: 20_000,
      tokens: { input: 10_000, output: 1_800, reasoning: 200, cacheRead: 90_000, cacheWrite: 2_000 },
      cost: 0.1234,
    },
  ]
  const parsed = parseRunLog(renderRunSummary(samples, "done", "", 3, "t"))
  const summary = parsed.summaries[0]
  assert.equal(summary?.rows[0]?.extra["tokens"], "102.0k/2.0k")
  assert.equal(summary?.rows[0]?.extra["cost"], "$0.1234")
  assert.equal(summary?.total, "20s")
  assert.equal(summary?.cost, 0.1234)
})

test("parseRunLog renders an empty-samples summary as no rows", () => {
  const log = `## Run summary · error: boom · 2026-07-05T13:00:00.000Z\n\n_(no stages ran)_\n\niterations used: 0/3 · total: 0s · outcome: error`
  const parsed = parseRunLog(log)
  assert.equal(parsed.summaries[0]?.rows.length, 0)
  assert.equal(parsed.summaries[0]?.iterationsUsed, 0)
})
