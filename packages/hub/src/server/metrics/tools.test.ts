import assert from "node:assert/strict"
import { test } from "node:test"
import { runInput, sample, sidecarOf } from "./fixtures.js"
import { toolStats } from "./tools.js"

test("toolStats rolls tool tallies up across runs, worst first", () => {
  const stats = toolStats([
    runInput(
      "a",
      "",
      sidecarOf([
        sample("build", { tools: [{ tool: "edit", count: 10, errors: 2 }] }),
        sample("verify", { tools: [{ tool: "bash", count: 5, errors: 0 }] }),
      ]),
    ),
    runInput("b", "", sidecarOf([sample("build", { tools: [{ tool: "edit", count: 4, errors: 1 }] })])),
    runInput("c", "", null),
  ])

  assert.deepEqual(
    stats.map((t) => t.tool),
    ["edit", "bash"],
  )
  const edit = stats[0]
  assert.ok(edit)
  assert.equal(edit.calls, 14)
  assert.equal(edit.errors, 3)
  assert.equal(edit.errorRate, 3 / 14)
  assert.equal(edit.runsCovered, 2)
})

test("toolStats keeps a zero-call tool unmeasurable, not 0%", () => {
  const stats = toolStats([
    runInput("a", "", sidecarOf([sample("build", { tools: [{ tool: "ghost", count: 0, errors: 0 }] })])),
  ])
  assert.equal(stats[0]?.errorRate, null)
})

test("toolStats is empty when no sidecar recorded tools", () => {
  assert.deepEqual(toolStats([runInput("a", "", sidecarOf([sample("build")]))]), [])
})
