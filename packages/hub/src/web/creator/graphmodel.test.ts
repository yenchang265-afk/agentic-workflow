import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultWorkflowsDir } from "@agentic-workflow/core/manifest/dir"
import { loadManifest, listWorkflowKinds } from "@agentic-workflow/core/manifest/load"
import { parseManifest } from "@agentic-workflow/core/manifest/schema"
import { graphToManifest, manifestToGraph, sameTerminalSpec, terminalId, terminalStatusOptions } from "./graphmodel.js"
import { layoutGraph } from "./layout.js"

test("graph round-trips every shipped manifest exactly", () => {
  for (const kind of listWorkflowKinds(defaultWorkflowsDir())) {
    const { manifest } = loadManifest(defaultWorkflowsDir(), kind)
    const roundTripped = graphToManifest(manifestToGraph(manifest))
    assert.deepEqual(roundTripped, manifest, `round-trip diverged for kind "${kind}"`)
    // and the round-tripped manifest still validates
    parseManifest(roundTripped)
  }
})

test("a stage's optional model survives the graph round-trip", () => {
  const { manifest } = loadManifest(defaultWorkflowsDir(), "engineering")
  const withModel = parseManifest({
    ...manifest,
    stages: manifest.stages.map((s, i) => (i === 0 ? { ...s, model: "anthropic/claude-sonnet-4-5" } : s)),
  })
  const roundTripped = graphToManifest(manifestToGraph(withModel))
  assert.equal(roundTripped.stages[0]?.model, "anthropic/claude-sonnet-4-5")
  assert.equal(roundTripped.stages[1]?.model, undefined)
})

test("terminals dedupe by outcome+status while messages stay on edges", () => {
  const { manifest } = loadManifest(defaultWorkflowsDir(), "engineering")
  const graph = manifestToGraph(manifest)
  const terminals = graph.nodes.filter((n) => n.type === "terminal")
  const ids = terminals.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length, "terminal ids must be unique")
  for (const edge of graph.edges) {
    if (edge.effect.kind !== "fire") {
      assert.equal(edge.to, terminalId(edge.effect))
      assert.ok("message" in edge.effect, "non-fire effects carry their message on the edge")
    }
  }
})

test("sameTerminalSpec matches terminalId's dedup semantics", () => {
  // stop ignores status entirely
  assert.ok(sameTerminalSpec({ outcome: "stop" }, { outcome: "stop", toStatus: "x" }))
  // park/done match only on equal status, undefined ≡ absent
  assert.ok(sameTerminalSpec({ outcome: "done", toStatus: "completed" }, { outcome: "done", toStatus: "completed" }))
  assert.ok(sameTerminalSpec({ outcome: "park" }, { outcome: "park" }))
  assert.ok(!sameTerminalSpec({ outcome: "done", toStatus: "completed" }, { outcome: "done" }))
  assert.ok(!sameTerminalSpec({ outcome: "done", toStatus: "a" }, { outcome: "done", toStatus: "b" }))
  // outcome always distinguishes
  assert.ok(!sameTerminalSpec({ outcome: "park", toStatus: "completed" }, { outcome: "done", toStatus: "completed" }))
  // consistency with terminalId: equal ids ⇒ matching specs, and vice versa
  const effects = [
    { kind: "done", message: "" },
    { kind: "done", toStatus: "completed", message: "" },
    { kind: "park", toStatus: "plan-review", message: "" },
    { kind: "stop", message: "" },
  ] as const
  for (const a of effects) {
    for (const b of effects) {
      const specOf = (e: (typeof effects)[number]) => ({ outcome: e.kind, ...("toStatus" in e ? { toStatus: e.toStatus } : {}) })
      assert.equal(terminalId(a) === terminalId(b), sameTerminalSpec(specOf(a), specOf(b)))
    }
  }
})

test("terminalStatusOptions exposes backlog statuses and nothing for other sources", () => {
  assert.deepEqual(
    terminalStatusOptions({ type: "backlog", statuses: ["queued", "in-progress", "completed"], humanGates: [], pools: [] }),
    ["queued", "in-progress", "completed"],
  )
  const { manifest } = loadManifest(defaultWorkflowsDir(), "pr-sitter")
  assert.deepEqual(terminalStatusOptions(manifest.workSource), [])
  const dep = loadManifest(defaultWorkflowsDir(), "dep-sitter").manifest
  assert.deepEqual(terminalStatusOptions(dep.workSource), [])
  const ci = loadManifest(defaultWorkflowsDir(), "main-sitter").manifest
  assert.deepEqual(terminalStatusOptions(ci.workSource), [])
})

test("stage order is preserved through the round-trip", () => {
  const { manifest } = loadManifest(defaultWorkflowsDir(), "pr-sitter")
  const names = graphToManifest(manifestToGraph(manifest)).stages.map((s) => s.name)
  assert.deepEqual(
    names,
    manifest.stages.map((s) => s.name),
  )
})

test("layoutGraph ranks fire-chains left to right and gives every node a position", () => {
  const { manifest } = loadManifest(defaultWorkflowsDir(), "engineering")
  const graph = manifestToGraph(manifest)
  const pos = layoutGraph(graph)
  for (const node of graph.nodes) assert.ok(pos[node.id], `no position for ${node.id}`)
  const x = (id: string): number => pos[id]?.x ?? -1
  assert.ok(x("build") < x("verify"), "build fires verify → verify sits right of build")
  assert.ok(x("verify") < x("review"), "verify fires review → review sits right of verify")
})
