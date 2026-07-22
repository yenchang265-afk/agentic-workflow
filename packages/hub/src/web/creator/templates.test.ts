import assert from "node:assert/strict"
import { test } from "node:test"
import { parseManifest, type WorkSourceBinding } from "@agentic-workflow/core/manifest/schema"
import { graphToManifest, manifestToGraph } from "./graphmodel.js"
import { layoutGraph } from "./layout.js"
import { stageChain, TEMPLATES } from "./templates.js"

test("every template parses, matches its work-source id, and round-trips exactly", () => {
  for (const t of TEMPLATES) {
    const manifest = t.manifest()
    parseManifest(manifest)
    assert.equal(manifest.workSource.type, t.id, `template "${t.label}" workSource must match its id`)
    assert.deepEqual(graphToManifest(manifestToGraph(manifest)), manifest, `round-trip diverged for template "${t.label}"`)
  }
})

test("the four templates cover all work-source types with no duplicates", () => {
  const ids = TEMPLATES.map((t) => t.id)
  const all: WorkSourceBinding["type"][] = ["backlog", "pull-request", "dependency-scan", "ci-runs"]
  assert.deepEqual([...ids].sort(), [...all].sort())
})

test("layoutGraph gives every template node a position", () => {
  for (const t of TEMPLATES) {
    const graph = manifestToGraph(t.manifest())
    const pos = layoutGraph(graph)
    for (const node of graph.nodes) assert.ok(pos[node.id], `no position for ${node.id} in template "${t.label}"`)
  }
})

test("the manifest factory returns a fresh object per call", () => {
  for (const t of TEMPLATES) {
    assert.notEqual(t.manifest(), t.manifest(), `template "${t.label}" must not alias a shared manifest`)
  }
})

test("stageChain joins stage names in order", () => {
  const backlog = TEMPLATES.find((t) => t.id === "backlog")
  assert.ok(backlog)
  assert.equal(stageChain(backlog.manifest()), "work → verify")
})
