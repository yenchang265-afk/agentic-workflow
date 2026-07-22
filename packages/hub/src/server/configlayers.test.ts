import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeConfigLayers } from "@agentic-workflow/core/config"
import { deleteAt, leafPaths, provenanceOf, setAt, valueAt } from "./configlayers.js"

/**
 * provenanceOf mirrors core's mergeConfigLayers rule. Mirroring is exactly where
 * this can go wrong, so the headline test here is an **oracle**: for every leaf
 * path over a set of layer pairs, the merged value must equal the value in the
 * layer provenance names. If core's merge rule ever changes, this goes red
 * rather than the UI quietly showing a wrong badge.
 */

const LAYER_PAIRS: readonly { name: string; user: unknown; repo: unknown }[] = [
  { name: "both empty", user: {}, repo: {} },
  { name: "repo only", user: {}, repo: { maxIterations: 9, tasksDir: "work" } },
  { name: "user only", user: { maxIterations: 5 }, repo: {} },
  { name: "repo overrides a user scalar", user: { maxIterations: 5 }, repo: { maxIterations: 9 } },
  {
    name: "nested objects merge per key",
    user: { ado: { organization: "acme", project: "p", pat: "secret" } },
    repo: { ado: { project: "other" } },
  },
  {
    name: "arrays replace wholesale, they do not concat",
    user: { reviewLenses: ["security", "perf"] },
    repo: { reviewLenses: [] },
  },
  {
    name: "a non-object override masks a user object entirely",
    user: { ado: { organization: "acme", pat: "secret" } },
    repo: { ado: false },
  },
  {
    name: "null replaces rather than deletes",
    user: { worktreeSetup: "npm ci" },
    repo: { worktreeSetup: null },
  },
  {
    name: "workflows sections merge per kind",
    user: { workflows: { engineering: { enabled: true }, "pr-sitter": { enabled: true } } },
    repo: { workflows: { "pr-sitter": { enabled: false, query: "is:open" } } },
  },
  {
    name: "keys core does not know ride along",
    user: { hub: { repos: ["/a"], port: 4317 } },
    repo: { watchIntervalMinutes: 5 },
  },
]

test("provenanceOf agrees with mergeConfigLayers on every leaf path (the oracle)", () => {
  for (const { name, user, repo } of LAYER_PAIRS) {
    const merged = mergeConfigLayers(user, repo)
    const paths = [...leafPaths(merged), ...leafPaths(user), ...leafPaths(repo)]
    for (const path of paths) {
      const from = provenanceOf(user, repo, path)
      const mergedValue = valueAt(merged, path)
      const expected = from === "repo" ? valueAt(repo, path) : from === "user" ? valueAt(user, path) : undefined
      assert.deepEqual(
        mergedValue,
        expected,
        `${name}: ${path.join(".")} — provenance said "${from}" but the merged value doesn't match that layer`,
      )
    }
  }
})

test("repo wins field by field, and an absent repo key falls through to the user layer", () => {
  const user = { maxIterations: 5, tasksDir: "user-tasks" }
  const repo = { maxIterations: 9 }
  assert.equal(provenanceOf(user, repo, ["maxIterations"]), "repo")
  assert.equal(provenanceOf(user, repo, ["tasksDir"]), "user")
  assert.equal(provenanceOf(user, repo, ["stageTimeoutMinutes"]), "default")
})

test("a wholesale replacement makes the whole subtree belong to the winning layer", () => {
  // repo.ado is not a plain object, so the merge replaces user.ado entirely —
  // user.ado.pat is NOT reachable in the merged view, and provenance must agree.
  const user = { ado: { organization: "acme", pat: "secret" } }
  const repo = { ado: false }
  assert.equal(provenanceOf(user, repo, ["ado"]), "repo")
  assert.equal(provenanceOf(user, repo, ["ado", "pat"]), "default", "the user's pat is masked, not merged")
  assert.equal(valueAt(mergeConfigLayers(user, repo), ["ado", "pat"]), undefined)
})

test("an array is a leaf — provenance never walks into its elements", () => {
  const user = { reviewLenses: ["security", "perf"] }
  const repo = { reviewLenses: ["a11y"] }
  assert.equal(provenanceOf(user, repo, ["reviewLenses"]), "repo")
  // A naive per-element walk would claim element 1 came from the user. It didn't:
  // mergeConfigLayers replaces arrays wholesale.
  assert.deepEqual(mergeConfigLayers(user, repo), { reviewLenses: ["a11y"] })
})

test("setAt and deleteAt are immutable and create intermediates", () => {
  const raw = { ado: { organization: "acme" } }
  const next = setAt(raw, ["ado", "project"], "p")
  assert.deepEqual(next, { ado: { organization: "acme", project: "p" } })
  assert.deepEqual(raw, { ado: { organization: "acme" } }, "the input must not be mutated")

  const created = setAt({}, ["projectManagement", "system"], "jira")
  assert.deepEqual(created, { projectManagement: { system: "jira" } })

  const pruned = deleteAt(next, ["ado", "project"])
  assert.deepEqual(pruned, { ado: { organization: "acme" } })
  assert.deepEqual(deleteAt(raw, ["nope"]), raw, "deleting an absent key is a no-op")
})

test("leafPaths walks plain objects and stops at arrays and scalars", () => {
  const paths = leafPaths({ a: 1, b: { c: 2 }, d: ["x"], e: {} }).map((p) => p.join("."))
  assert.deepEqual(paths.sort(), ["a", "b.c", "d", "e"])
})
