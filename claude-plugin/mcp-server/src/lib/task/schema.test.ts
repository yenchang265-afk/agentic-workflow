import assert from "node:assert/strict"
import { test } from "node:test"
import { buildTaskFile, parseTask, serializeTask, slugify } from "./schema.js"

const PATH = "/repo/docs/tasks/in-progress/add-foo.md"

test("parses frontmatter and separates the body", () => {
  const content = [
    "---",
    "title: Add rate limiting",
    "priority: 2",
    "acceptance:",
    "  - Returns 429 over the limit",
    "  - Limit is configurable",
    "---",
    "Throttle callers to 100 req/min.",
  ].join("\n")
  const task = parseTask("add-foo.md", content, PATH)
  assert.equal(task.id, "add-foo")
  assert.equal(task.title, "Add rate limiting")
  assert.equal(task.priority, 2)
  assert.deepEqual(task.acceptance, ["Returns 429 over the limit", "Limit is configurable"])
  assert.equal(task.body, "Throttle callers to 100 req/min.")
  assert.equal(task.path, PATH)
})

test("defaults priority to 0 and acceptance to []", () => {
  const task = parseTask("t.md", "---\ntitle: Just a title\n---\nbody", "/p/t.md")
  assert.equal(task.priority, 0)
  assert.deepEqual(task.acceptance, [])
})

test("throws when the title is missing", () => {
  assert.throws(() => parseTask("t.md", "---\npriority: 1\n---\nbody", "/p"), /title/)
})

test("throws when the title is present but empty", () => {
  assert.throws(() => parseTask("t.md", '---\ntitle: ""\n---\nbody', "/p"), /title is required/)
})

test("throws when there is no frontmatter block", () => {
  assert.throws(() => parseTask("t.md", "no frontmatter here", "/p"), /missing YAML frontmatter/)
})

test("throws on invalid YAML in the frontmatter", () => {
  assert.throws(() => parseTask("t.md", "---\ntitle: : :\n  bad: indent\n---\nb", "/p"), /t\.md:/)
})

// --- serializeTask / slugify / buildTaskFile ---

test("slugify kebab-cases a title", () => {
  assert.equal(slugify("Add Rate Limiting to the API!"), "add-rate-limiting-to-the-api")
  assert.equal(slugify("  Trim -- Edges  "), "trim-edges")
  assert.equal(slugify("Café & Crème"), "caf-cr-me")
})

test("serializeTask round-trips through parseTask", () => {
  const content = serializeTask({
    title: "Add rate limiting",
    priority: 2,
    acceptance: ["Returns 429 over the limit", "Configurable per route"],
    body: "Throttle callers to 100 req/min.",
  })
  const task = parseTask("add-rate-limiting.md", content, "/p/add-rate-limiting.md")
  assert.equal(task.title, "Add rate limiting")
  assert.equal(task.priority, 2)
  assert.deepEqual(task.acceptance, ["Returns 429 over the limit", "Configurable per route"])
  assert.equal(task.body, "Throttle callers to 100 req/min.")
})

test("serializeTask applies schema defaults (priority 0, acceptance [])", () => {
  const task = parseTask("t.md", serializeTask({ title: "Just a title" }), "/p")
  assert.equal(task.priority, 0)
  assert.deepEqual(task.acceptance, [])
  assert.equal(task.body, "")
})

test("serializeTask rejects an empty title", () => {
  assert.throws(() => serializeTask({ title: "" }), /title is required/)
})

test("buildTaskFile derives id/filename from the title", () => {
  const file = buildTaskFile({ title: "Add a foo helper" })
  assert.equal(file.id, "add-a-foo-helper")
  assert.equal(file.filename, "add-a-foo-helper.md")
  assert.match(file.content, /title: Add a foo helper/)
})

test("buildTaskFile avoids id collisions with a numeric suffix", () => {
  assert.equal(buildTaskFile({ title: "Foo" }, ["foo"]).id, "foo-2")
  assert.equal(buildTaskFile({ title: "Foo" }, ["foo", "foo-2"]).id, "foo-3")
  assert.equal(buildTaskFile({ title: "Foo" }, ["bar"]).id, "foo")
})

test("buildTaskFile falls back to 'task' when the title has no slug chars", () => {
  assert.equal(buildTaskFile({ title: "!!!" }).id, "task")
})

// --- Azure DevOps linkage fields ---

test("parses azureId/azureProject/azureRepo/azureUrl from frontmatter", () => {
  const content = [
    "---",
    "title: Add rate limiting",
    "azureId: '1234'",
    "azureProject: Platform",
    "azureRepo: platform-api",
    "azureUrl: https://dev.azure.com/acme/Platform/_workitems/edit/1234",
    "---",
  ].join("\n")
  const task = parseTask("add-foo.md", content, PATH)
  assert.equal(task.azureId, "1234")
  assert.equal(task.azureProject, "Platform")
  assert.equal(task.azureRepo, "platform-api")
  assert.equal(task.azureUrl, "https://dev.azure.com/acme/Platform/_workitems/edit/1234")
})

test("omits azure fields from a parsed task when absent", () => {
  const task = parseTask("t.md", "---\ntitle: Just a title\n---\nbody", "/p/t.md")
  assert.equal("azureId" in task, false)
  assert.equal("azureProject" in task, false)
  assert.equal("azureRepo" in task, false)
  assert.equal("azureUrl" in task, false)
})

test("rejects an invalid azureUrl", () => {
  assert.throws(
    () => parseTask("t.md", "---\ntitle: T\nazureUrl: not-a-url\n---\nb", "/p"),
    /azureUrl/,
  )
})

test("serializeTask round-trips azure linkage fields", () => {
  const content = serializeTask({
    title: "Add rate limiting",
    azureId: "1234",
    azureProject: "Platform",
    azureRepo: "platform-api",
    azureUrl: "https://dev.azure.com/acme/Platform/_workitems/edit/1234",
  })
  const task = parseTask("t.md", content, "/p/t.md")
  assert.equal(task.azureId, "1234")
  assert.equal(task.azureProject, "Platform")
  assert.equal(task.azureRepo, "platform-api")
  assert.equal(task.azureUrl, "https://dev.azure.com/acme/Platform/_workitems/edit/1234")
})

test("serializeTask omits azure fields from the frontmatter when not given", () => {
  const content = serializeTask({ title: "Just a title" })
  assert.doesNotMatch(content, /azureId/)
  assert.doesNotMatch(content, /azureProject/)
  assert.doesNotMatch(content, /azureRepo/)
  assert.doesNotMatch(content, /azureUrl/)
})

test("azure linkage fields are independently optional (id without project is fine)", () => {
  const content = serializeTask({ title: "T", azureId: "1234" })
  const task = parseTask("t.md", content, "/p/t.md")
  assert.equal(task.azureId, "1234")
  assert.equal("azureProject" in task, false)
})
