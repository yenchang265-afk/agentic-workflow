import assert from "node:assert/strict"
import { test } from "node:test"
import { buildTaskFile, isPaired, parseTask, serializeTask, slugify } from "./schema.js"

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

// --- Jira / Azure DevOps alignment fields ---

test("parses the tracker pairing block and aligned fields", () => {
  const content = [
    "---",
    "title: Add rate limiting",
    "type: story",
    "priority: 2",
    "estimate: 3",
    "assignee: jdoe@example.com",
    "labels:",
    "  - backend",
    "  - security",
    "acceptance:",
    "  - Returns 429 over the limit",
    "tracker:",
    "  system: jira",
    "  key: PROJ-123",
    "  url: https://acme.atlassian.net/browse/PROJ-123",
    "  parent: PROJ-100",
    "---",
    "body",
  ].join("\n")
  const task = parseTask("add-foo.md", content, PATH)
  assert.equal(task.type, "story")
  assert.equal(task.estimate, 3)
  assert.equal(task.assignee, "jdoe@example.com")
  assert.deepEqual(task.labels, ["backend", "security"])
  assert.deepEqual(task.tracker, {
    system: "jira",
    key: "PROJ-123",
    url: "https://acme.atlassian.net/browse/PROJ-123",
    parent: "PROJ-100",
  })
})

test("pairs against Azure DevOps by work item id", () => {
  const content = [
    "---",
    "title: Fix login redirect",
    "type: bug",
    "tracker:",
    "  system: azure-devops",
    "  key: '1234'",
    "---",
    "",
  ].join("\n")
  const task = parseTask("t.md", content, "/p/t.md")
  assert.deepEqual(task.tracker, { system: "azure-devops", key: "1234" })
})

test("defaults the aligned fields when absent (labels [], rest undefined)", () => {
  const task = parseTask("t.md", "---\ntitle: Just a title\n---\nbody", "/p/t.md")
  assert.deepEqual(task.labels, [])
  assert.equal(task.type, undefined)
  assert.equal(task.estimate, undefined)
  assert.equal(task.assignee, undefined)
  assert.equal(task.tracker, undefined)
})

test("rejects an unknown tracker system", () => {
  assert.throws(
    () => parseTask("t.md", "---\ntitle: X\ntracker:\n  system: trello\n  key: A-1\n---\nb", "/p"),
    /tracker\.system/,
  )
})

test("rejects a tracker without a key", () => {
  assert.throws(
    () => parseTask("t.md", "---\ntitle: X\ntracker:\n  system: jira\n---\nb", "/p"),
    /tracker\.key/,
  )
})

test("serializeTask omits unset optional fields but keeps the pairing", () => {
  const content = serializeTask({
    title: "Add rate limiting",
    type: "story",
    tracker: { system: "azure-devops", key: "1234", url: "https://dev.azure.com/acme/_workitems/edit/1234" },
  })
  assert.match(content, /type: story/)
  assert.match(content, /system: azure-devops/)
  assert.match(content, /key: ["']1234["']/)
  assert.doesNotMatch(content, /assignee/)
  assert.doesNotMatch(content, /estimate/)
  assert.doesNotMatch(content, /labels/)
  assert.doesNotMatch(content, /parent/)
})

test("isPaired reflects whether a tracker block is present", () => {
  assert.equal(isPaired({ tracker: undefined }), false)
  assert.equal(isPaired({ tracker: { system: "jira", key: "PROJ-1" } }), true)
})

test("serializeTask round-trips the aligned fields through parseTask", () => {
  const content = serializeTask({
    title: "Add rate limiting",
    type: "story",
    priority: 2,
    estimate: 5,
    assignee: "jdoe",
    labels: ["backend"],
    acceptance: ["Returns 429 over the limit"],
    tracker: { system: "jira", key: "PROJ-123", parent: "PROJ-100" },
    body: "Throttle callers.",
  })
  const task = parseTask("add-rate-limiting.md", content, "/p/add-rate-limiting.md")
  assert.equal(task.type, "story")
  assert.equal(task.estimate, 5)
  assert.equal(task.assignee, "jdoe")
  assert.deepEqual(task.labels, ["backend"])
  assert.deepEqual(task.tracker, { system: "jira", key: "PROJ-123", parent: "PROJ-100" })
})
