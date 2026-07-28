import assert from "node:assert/strict"
import { test } from "node:test"
import { runInput, sample, sidecarOf } from "./fixtures.js"
import { modelStats } from "./models.js"

test("modelStats groups by stage × model and sums cost over cost-bearing samples only", () => {
  const stats = modelStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("build", { model: "sonnet", cost: 0.1, ms: 2000 }),
        sample("build", { model: "sonnet", cost: 0.3, ms: 4000, iteration: 1 }),
        sample("review", { model: "opus", ms: 1000 }), // no cost recorded
      ]),
    ),
  ])

  assert.equal(stats.runsCovered, 1)
  assert.equal(stats.samplesWithoutModel, 0)
  const build = stats.rows.find((r) => r.stage === "build" && r.model === "sonnet")
  assert.ok(build)
  assert.equal(build.samples, 2)
  assert.equal(build.costSamples, 2)
  assert.equal(build.totalCost, 0.4)
  assert.equal(build.meanMs, 3000)
  // Sidecar iterations are 0-based; the mean reports 1-based: (1 + 2) / 2.
  assert.equal(build.meanIteration, 1.5)
  const review = stats.rows.find((r) => r.stage === "review" && r.model === "opus")
  assert.ok(review)
  assert.equal(review.costSamples, 0)
  assert.equal(review.totalCost, 0)
})

test("modelStats counts model-less samples aside instead of bucketing them", () => {
  const stats = modelStats([
    runInput("a", "", sidecarOf([sample("build"), sample("verify", { model: "sonnet" })])),
    runInput("b", "", sidecarOf([sample("build")])), // claude-host style: no models at all
    runInput("c", "", null), // no sidecar
  ])

  assert.equal(stats.samplesWithoutModel, 2)
  // Run b carried samples but none with a model — it is not covered.
  assert.equal(stats.runsCovered, 1)
  assert.deepEqual(
    stats.rows.map((r) => `${r.stage}/${r.model}`),
    ["verify/sonnet"],
  )
})

test("modelStats sorts by total cost, then sample count", () => {
  const stats = modelStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("build", { model: "sonnet", cost: 0.5 }),
        sample("plan", { model: "haiku", cost: 0.1 }),
        sample("verify", { model: "haiku" }),
        sample("verify", { model: "haiku" }),
      ]),
    ),
  ])
  assert.deepEqual(
    stats.rows.map((r) => r.stage),
    ["build", "plan", "verify"],
  )
})
