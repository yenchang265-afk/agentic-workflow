import assert from "node:assert/strict"
import { test } from "node:test"
import { applyUserRepoOverrides, mergeConfigLayers, modelSubtrees } from "./qwen-agents.mjs"

/**
 * The installer resolves models from a merge of the user-scope and
 * project-scope config layers before baking them into each Qwen agent file
 * (see the module docstring: install time, not runtime, since Qwen agents
 * have no per-call `model` argument). This merge must match the real runtime
 * config loader's deep merge (`config-layers.ts`'s `mergeConfigLayers`,
 * duplicated here rather than imported) — a plain top-level spread let a
 * project config's `workflows.<anyKind>` silently REPLACE a user config's
 * `workflows.<otherKind>` instead of merging with it.
 */

test("a project layer's other-kind section does not wipe the user layer's kind", () => {
  const user = { workflows: { engineering: { stageModels: { build: "opus" } } } }
  const project = { workflows: { "pr-sitter": { stageModels: { triage: "haiku" } } } }
  const merged = mergeConfigLayers(user, project)
  assert.deepEqual(merged.workflows.engineering, { stageModels: { build: "opus" } }, "the user layer's kind must survive untouched")
  assert.deepEqual(merged.workflows["pr-sitter"], { stageModels: { triage: "haiku" } })
})

test("a project layer's same-kind section merges field-by-field, project wins", () => {
  const user = { workflows: { engineering: { stageModels: { build: "opus", verify: "sonnet" } } } }
  const project = { workflows: { engineering: { stageModels: { build: "haiku" } } } }
  const merged = mergeConfigLayers(user, project)
  assert.deepEqual(merged.workflows.engineering.stageModels, { build: "haiku", verify: "sonnet" })
})

test("arrays and scalars replace wholesale, never merge element-wise", () => {
  const merged = mergeConfigLayers({ protectedBranches: ["a", "b"], shipPublish: "pr" }, { protectedBranches: ["c"], shipPublish: "local" })
  assert.deepEqual(merged.protectedBranches, ["c"])
  assert.equal(merged.shipPublish, "local")
})

test("an absent project layer leaves the user layer untouched", () => {
  const user = { workflows: { engineering: { stageModels: { build: "opus" } } } }
  assert.deepEqual(mergeConfigLayers(user, {}), user)
})

test("a non-object override replaces the base outright, matching core's mergeConfigLayers", () => {
  assert.equal(mergeConfigLayers({ a: 1 }, null), null)
  const base = { a: 1 }
  assert.equal(mergeConfigLayers(base, undefined), base, "undefined override returns base unchanged")
})

test("the installer folds the user layer's repos.<match> section in, absolute path before basename (design 73 twin)", () => {
  const user = { agentModels: { "workflow-build": "sonnet" }, repos: { "/work/app": { agentModels: { "workflow-build": "opus" } }, app: { agentModels: { "workflow-build": "haiku" } } } }
  assert.deepEqual(applyUserRepoOverrides(user, "/work/app"), { agentModels: { "workflow-build": "opus" } })
  assert.deepEqual(applyUserRepoOverrides(user, "/other/app"), { agentModels: { "workflow-build": "haiku" } })
  assert.deepEqual(applyUserRepoOverrides(user, "/other/none"), { agentModels: { "workflow-build": "sonnet" } })
})

test("modelSubtrees projects exactly the model-deciding keys, so an unrelated edit is not drift (design 74)", () => {
  const config = { maxIterations: 3, agentModels: { "workflow-build": "opus" }, workflows: { engineering: { stageModels: { verify: "haiku" }, enabled: true }, "pr-sitter": { enabled: true } } }
  assert.deepEqual(modelSubtrees(config), { agentModels: { "workflow-build": "opus" }, workflows: { engineering: { verify: "haiku" } } })
  assert.deepEqual(modelSubtrees({ ...config, maxIterations: 9 }), modelSubtrees(config))
  assert.deepEqual(modelSubtrees({}), { agentModels: {}, workflows: {} })
})
