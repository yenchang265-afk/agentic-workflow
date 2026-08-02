import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunMetrics } from "@agentic-workflow/core/workflow/metrics-file"
import { promptSize } from "./prompt.js"
import { runInput } from "./fixtures.js"

const sidecar = (
  samples: readonly { stage: string; promptChars?: number; promptElided?: number; lens?: string; tokens?: unknown }[],
  host: "opencode" | "claude" = "opencode",
): RunMetrics =>
  ({
    version: 1,
    runs: [
      {
        endedAt: "2026-07-05T13:16:25.138Z",
        outcome: "done" as const,
        detail: "",
        host,
        samples: samples.map((s, i) => ({ iteration: i, ms: 1_000, ...s })),
      },
    ],
  }) as RunMetrics

test("promptSize aggregates per stage across both hosts, including samples with no tokens block", () => {
  // The Claude host never records tokens, so a promptChars aggregate gated on
  // `tokens` (as the cache ratio is) would be blind to exactly this run.
  const result = promptSize([
    runInput("a", "", sidecar([{ stage: "build", promptChars: 10_000 }, { stage: "build", promptChars: 20_000 }])),
    runInput("b", "", sidecar([{ stage: "build", promptChars: 30_000 }, { stage: "verify", promptChars: 5_000 }], "claude")),
  ])
  assert.equal(result.runsCovered, 2)
  assert.equal(result.samples, 4)

  const build = result.stages.find((s) => s.stage === "build")
  assert.equal(build?.samples, 3)
  assert.equal(build?.meanChars, 20_000)
  assert.equal(build?.medianChars, 20_000)
  assert.equal(build?.maxChars, 30_000)
  // Sorted by max, so the biggest prompt leads.
  assert.equal(result.stages[0]?.stage, "build")
})

test("promptSize separates 'the budget is biting' from 'the prompt is small'", () => {
  const result = promptSize([
    runInput("a", "", sidecar([
      { stage: "build", promptChars: 24_000, promptElided: 6_000 },
      { stage: "build", promptChars: 8_000 },
      { stage: "verify", promptChars: 4_000 },
    ])),
  ])
  const build = result.stages.find((s) => s.stage === "build")
  assert.equal(build?.elidedSamples, 1, "only the clamped pass counts")
  assert.equal(build?.elidedChars, 6_000)
  const verify = result.stages.find((s) => s.stage === "verify")
  assert.equal(verify?.elidedSamples, 0)
  assert.equal(verify?.elidedChars, 0)
})

test("promptSize breaks a fanned-out stage down per focus, and leaves lens-less stages alone", () => {
  const result = promptSize([
    runInput("a", "", sidecar([
      { stage: "review", promptChars: 10_000, lens: "correctness" },
      { stage: "review", promptChars: 14_000, lens: "security" },
      { stage: "build", promptChars: 30_000 },
    ])),
  ])
  const review = result.stages.find((s) => s.stage === "review")
  assert.equal(review?.focuses?.length, 2)
  // Sorted by max, so the heaviest focus leads.
  assert.deepEqual(review?.focuses?.[0], { focus: "security", samples: 1, meanChars: 14_000, maxChars: 14_000 })
  const build = result.stages.find((s) => s.stage === "build")
  assert.equal(build?.focuses, undefined, "a single-pass stage carries no focus breakdown")
})

test("promptSize is empty when no sample carries promptChars — pre-upgrade sidecars", () => {
  const result = promptSize([runInput("a", "", sidecar([{ stage: "build" }, { stage: "verify" }]))])
  assert.deepEqual(result, { runsCovered: 0, samples: 0, stages: [] })
})

test("promptSize tolerates a run with no sidecar at all", () => {
  assert.deepEqual(promptSize([runInput("a", "")]), { runsCovered: 0, samples: 0, stages: [] })
})
