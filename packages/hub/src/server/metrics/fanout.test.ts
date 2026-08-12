import assert from "node:assert/strict"
import { test } from "node:test"
import { fanoutStats } from "./fanout.js"
import { runInput, sample, sidecarOf } from "./fixtures.js"

test("fanoutStats groups one arming's lens passes and sums their prompt bill", () => {
  const result = fanoutStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("review", { lens: "correctness", promptChars: 10_000 }),
        sample("review", { lens: "security", promptChars: 12_000 }),
        sample("review", { lens: "performance", promptChars: 8_000 }),
      ]),
    ),
  ])
  assert.equal(result.stages.length, 1)
  const review = result.stages[0]
  assert.equal(review?.stage, "review")
  assert.equal(review?.armings, 1)
  assert.equal(review?.meanPasses, 3)
  assert.equal(review?.maxPasses, 3)
  // The arming's bill is the SUM — every pass sent the whole composed prompt.
  assert.equal(review?.meanArmingPromptChars, 30_000)
})

test("a verdict retry of one lens does not widen the fan-out, but its prompt was still sent", () => {
  const result = fanoutStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("review", { lens: "correctness", promptChars: 10_000 }),
        sample("review", { lens: "correctness", promptChars: 10_500 }),
        sample("review", { lens: "security", promptChars: 12_000 }),
      ]),
    ),
  ])
  const review = result.stages[0]
  assert.equal(review?.meanPasses, 2, "distinct focuses, not samples")
  assert.equal(review?.meanArmingPromptChars, 32_500, "retry's prompt counts toward the bill")
})

test("separate iterations are separate armings", () => {
  const result = fanoutStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("review", { iteration: 0, lens: "correctness", promptChars: 10_000 }),
        sample("review", { iteration: 0, lens: "security", promptChars: 10_000 }),
        sample("review", { iteration: 1, lens: "correctness", promptChars: 20_000 }),
        sample("review", { iteration: 1, lens: "security", promptChars: 20_000 }),
      ]),
    ),
  ])
  const review = result.stages[0]
  assert.equal(review?.armings, 2)
  assert.equal(review?.meanPasses, 2)
  assert.equal(review?.meanArmingPromptChars, 30_000)
})

test("single-pass stages (no lens label) report no fan-out at all", () => {
  const result = fanoutStats([
    runInput("a", "", sidecarOf([sample("build", { promptChars: 40_000 }), sample("verify", { promptChars: 9_000 })])),
  ])
  assert.deepEqual(result, { stages: [] })
})

test("lens passes without prompt sizes still count armings, with a null bill", () => {
  const result = fanoutStats([
    runInput("a", "", sidecarOf([sample("review", { lens: "correctness" }), sample("review", { lens: "security" })])),
  ])
  const review = result.stages[0]
  assert.equal(review?.armings, 1)
  assert.equal(review?.meanPasses, 2)
  assert.equal(review?.meanArmingPromptChars, null)
})

test("fanoutStats tolerates a run with no sidecar", () => {
  assert.deepEqual(fanoutStats([runInput("a", "")]), { stages: [] })
})

test("an arming whose samples carry unreviewedAxes counts as downgraded, with the axis union", () => {
  const result = fanoutStats([
    runInput(
      "a",
      "",
      sidecarOf([
        // downgraded arming: two lens passes, both stamped with the gap
        sample("review", { iteration: 0, lens: "security", unreviewedAxes: ["correctness", "performance"] }),
        sample("review", { iteration: 0, lens: "test-adequacy", unreviewedAxes: ["correctness", "performance"] }),
        // covered arming: a later run whose lenses span the axes
        sample("review", { iteration: 1, lens: "correctness" }),
        sample("review", { iteration: 1, lens: "security" }),
      ]),
    ),
  ])
  const review = result.stages[0]
  assert.equal(review?.armings, 2)
  assert.equal(review?.downgradedArmings, 1)
  assert.deepEqual(review?.unreviewedAxes, ["correctness", "performance"])
})

test("armings without the field report zero downgrades and no axes", () => {
  const result = fanoutStats([
    runInput("a", "", sidecarOf([sample("review", { lens: "correctness" }), sample("review", { lens: "security" })])),
  ])
  const review = result.stages[0]
  assert.equal(review?.downgradedArmings, 0)
  assert.deepEqual(review?.unreviewedAxes, [])
})
