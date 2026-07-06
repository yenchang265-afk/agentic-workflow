import assert from "node:assert/strict"
import { test } from "node:test"
import { renderPrompt, renderSection } from "./template.js"

test("interpolates dot paths and renders unknown paths as empty", () => {
  assert.equal(renderSection("Goal: {{goal}} on {{git.branch}}", { goal: "g", git: { branch: "b" } }), "Goal: g on b")
  assert.equal(renderSection("x{{nope}}y{{git.nope}}z", { git: { branch: "b" } }), "xyz")
})

test("blocks render only when truthy — empty strings and false are falsy", () => {
  assert.equal(renderSection("{{#a}}yes{{/a}}", { a: "v" }), "yes")
  assert.equal(renderSection("{{#a}}yes{{/a}}", { a: "" }), "")
  assert.equal(renderSection("{{#a}}yes{{/a}}", { a: false }), "")
  assert.equal(renderSection("{{#a}}yes{{/a}}", {}), "")
  assert.equal(renderSection("{{#a}}yes{{/a}}", { a: {} }), "yes")
})

test("blocks nest", () => {
  const tpl = "{{#git}}on {{git.branch}}{{#git.worktree}} in {{git.worktree}}{{/git.worktree}}{{/git}}"
  assert.equal(renderPrompt(tpl, { git: { branch: "b", worktree: "/wt" } }), "on b in /wt")
  assert.equal(renderPrompt(tpl, { git: { branch: "b", worktree: "" } }), "on b")
  assert.equal(renderPrompt(tpl, {}), "")
})

test("renderPrompt drops empty sections and joins survivors with a blank line", () => {
  const tpl = "Goal: {{goal}}\n---\n{{#plan}}Plan:\n{{plan}}{{/plan}}\n---\nAlways here"
  assert.equal(renderPrompt(tpl, { goal: "g", plan: "P" }), "Goal: g\n\nPlan:\nP\n\nAlways here")
  assert.equal(renderPrompt(tpl, { goal: "g" }), "Goal: g\n\nAlways here")
})

test("a --- separator must sit on its own line — inline dashes stay literal", () => {
  assert.equal(renderPrompt("a --- b", {}), "a --- b")
})
