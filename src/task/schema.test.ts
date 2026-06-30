import assert from "node:assert/strict"
import { test } from "node:test"
import { parseTask } from "./schema.ts"

const PATH = "/repo/docs/tasks/approved/add-foo.md"

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
