import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultLoopsDir } from "@agentic-loop/core/manifest/dir"
import { loadManifest, listLoopKinds } from "@agentic-loop/core/manifest/load"
import { parseManifest } from "@agentic-loop/core/manifest/schema"
import { graphToManifest, manifestToGraph, terminalId } from "./graphmodel.js"
import { layoutGraph } from "./layout.js"

test("graph round-trips every shipped manifest exactly", () => {
  for (const kind of listLoopKinds(defaultLoopsDir())) {
    const { manifest } = loadManifest(defaultLoopsDir(), kind)
    const roundTripped = graphToManifest(manifestToGraph(manifest))
    assert.deepEqual(roundTripped, manifest, `round-trip diverged for kind "${kind}"`)
    // and the round-tripped manifest still validates
    parseManifest(roundTripped)
  }
})

test("a stage's optional model survives the graph round-trip", () => {
  const { manifest } = loadManifest(defaultLoopsDir(), "engineering")
  const withModel = parseManifest({
    ...manifest,
    stages: manifest.stages.map((s, i) => (i === 0 ? { ...s, model: "anthropic/claude-sonnet-4-5" } : s)),
  })
  const roundTripped = graphToManifest(manifestToGraph(withModel))
  assert.equal(roundTripped.stages[0]?.model, "anthropic/claude-sonnet-4-5")
  assert.equal(roundTripped.stages[1]?.model, undefined)
})

test("terminals dedupe by outcome+status while messages stay on edges", () => {
  const { manifest } = loadManifest(defaultLoopsDir(), "engineering")
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

test("stage order is preserved through the round-trip", () => {
  const { manifest } = loadManifest(defaultLoopsDir(), "pr-sitter")
  const names = graphToManifest(manifestToGraph(manifest)).stages.map((s) => s.name)
  assert.deepEqual(
    names,
    manifest.stages.map((s) => s.name),
  )
})

test("layoutGraph ranks fire-chains left to right and gives every node a position", () => {
  const { manifest } = loadManifest(defaultLoopsDir(), "engineering")
  const graph = manifestToGraph(manifest)
  const pos = layoutGraph(graph)
  for (const node of graph.nodes) assert.ok(pos[node.id], `no position for ${node.id}`)
  const x = (id: string): number => pos[id]?.x ?? -1
  assert.ok(x("build") < x("verify"), "build fires verify → verify sits right of build")
  assert.ok(x("verify") < x("review"), "verify fires review → review sits right of verify")
})
