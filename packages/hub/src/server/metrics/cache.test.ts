import assert from "node:assert/strict"
import { test } from "node:test"
import type { StageTokens } from "@agentic-workflow/core/workflow/metrics"
import type { RunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import { cacheHit, countInProgress } from "./cache.js"
import { runInput, summary } from "./fixtures.js"

const tokens = (input: number, cacheRead: number): StageTokens => ({
  input,
  output: 100,
  reasoning: 0,
  cacheRead,
  cacheWrite: 0,
})

const sidecar = (
  samples: readonly { stage: string; tokens?: StageTokens }[],
  open?: boolean,
): RunMetrics => ({
  version: 1,
  runs: [
    {
      endedAt: "2026-07-05T13:16:25.138Z",
      ...(open ? { open: true } : { outcome: "done" as const }),
      detail: "",
      host: "opencode" as const,
      samples: samples.map((s, i) => ({
        stage: s.stage,
        // 0-based on the sidecar, unlike the run log's 1-based table.
        iteration: i,
        ms: 1000,
        ...(s.tokens ? { tokens: s.tokens } : {}),
      })),
    },
  ],
})

const log = summary("done", [])

test("cacheHit weights the ratio by tokens, not by stage", () => {
  // build reads 900 of 1000; verify reads 0 of 10. A mean of the two ratios
  // would say 45%; the honest token-weighted answer is 900/1010 ≈ 89%.
  const s = sidecar([
    { stage: "build", tokens: tokens(100, 900) },
    { stage: "verify", tokens: tokens(10, 0) },
  ])
  const hit = cacheHit([runInput("a", log, s)])

  assert.equal(hit.input, 110)
  assert.equal(hit.cacheRead, 900)
  assert.equal(hit.ratio, 900 / 1010)
  assert.equal(hit.samples, 2)
  assert.equal(hit.runsCovered, 1)

  const build = hit.stages.find((x) => x.stage === "build")
  assert.equal(build?.ratio, 0.9)
  assert.equal(hit.stages.find((x) => x.stage === "verify")?.ratio, 0)
})

test("cacheHit is null, not zero, when nothing observed tokens", () => {
  const hit = cacheHit([runInput("a", log, sidecar([{ stage: "build" }]))])

  assert.equal(hit.ratio, null)
  assert.equal(hit.samples, 0)
  // The run exists but contributes no observation — it must not inflate coverage.
  assert.equal(hit.runsCovered, 0)
  assert.deepEqual(hit.stages, [])
})

test("cacheHit ignores runs with no sidecar at all", () => {
  const hit = cacheHit([runInput("a", log, null)])
  assert.equal(hit.ratio, null)
  assert.equal(hit.runsCovered, 0)
})

test("cacheHit counts samples from a still-open entry", () => {
  // `upsertRunMetrics` REPLACES a trailing open entry rather than appending, so
  // an open entry is never a duplicate of a finalized one — excluding it would
  // just discard real observations from live runs.
  const hit = cacheHit([runInput("a", log, sidecar([{ stage: "build", tokens: tokens(50, 50) }], true))])

  assert.equal(hit.samples, 1)
  assert.equal(hit.ratio, 0.5)
  assert.equal(hit.runsCovered, 1)
})

test("cacheHit sums a stage appearing across several runs", () => {
  const a = sidecar([{ stage: "build", tokens: tokens(100, 100) }])
  const b = sidecar([{ stage: "build", tokens: tokens(300, 500) }])
  const hit = cacheHit([runInput("a", log, a), runInput("b", log, b)])

  const build = hit.stages.find((x) => x.stage === "build")
  assert.equal(build?.samples, 2)
  assert.equal(build?.input, 400)
  assert.equal(build?.cacheRead, 600)
  assert.equal(hit.runsCovered, 2)
})

test("countInProgress counts sidecars whose trailing entry is still open", () => {
  const open = sidecar([{ stage: "build", tokens: tokens(1, 1) }], true)
  const closed = sidecar([{ stage: "build", tokens: tokens(1, 1) }])
  assert.equal(countInProgress([runInput("a", log, open), runInput("b", log, closed)]), 1)
  assert.equal(countInProgress([runInput("b", log, closed), runInput("c", log, null)]), 0)
})
