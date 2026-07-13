import assert from "node:assert/strict"
import { test } from "node:test"
import { buildTaskFile, isPaired, mintShortId, parseTask, serializeTask, shortIdOf, slugify, SHORT_ID_LEN } from "./schema.js"

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

// The YAML colon-space footgun: an acceptance bullet containing `: ` parses as
// a single-key map, not a string. A degraded/human author trips this routinely;
// before the coercion, parseTask threw and every gate toasted "no task found"
// for a file plainly present on disk. See coerceListItem in schema.ts.
test("recovers acceptance items tripped by the YAML colon-space footgun", () => {
  const content = [
    "---",
    "title: Portfolio tracker",
    "acceptance:",
    "  - User records a transaction (ticker, shares, price, market: TW/US)",
    "  - App auto-fetches prices for TW and US tickers",
    "  - Dashboard shows a holdings list: ticker, price, unrealized P&L",
    "---",
    "body",
  ].join("\n")
  const task = parseTask("portfolio.md", content, "/p/portfolio.md")
  assert.deepEqual(task.acceptance, [
    "User records a transaction (ticker, shares, price, market: TW/US)",
    "App auto-fetches prices for TW and US tickers",
    "Dashboard shows a holdings list: ticker, price, unrealized P&L",
  ])
})

test("coerces bare-scalar acceptance/labels items to strings", () => {
  const content = ["---", "title: t", "labels:", "  - 2330", "acceptance:", "  - 429", "---", "b"].join("\n")
  const task = parseTask("t.md", content, "/p")
  assert.deepEqual(task.labels, ["2330"])
  assert.deepEqual(task.acceptance, ["429"])
})

test("recovers a labels item tripped by the colon-space footgun", () => {
  const content = ["---", "title: t", "labels:", "  - area: auth service", "---", "b"].join("\n")
  const task = parseTask("t.md", content, "/p")
  assert.deepEqual(task.labels, ["area: auth service"])
})

// The YAML reserved-character footgun: a bullet STARTING with a backtick (or
// @, *, [, …) kills the lexer itself — coercion never gets a chance, parseTask
// threw, and every gate reported "no task found" for a file on disk (observed
// live: a `- \`calc --help\` prints usage` acceptance bullet). parseTask now
// retries the parse with the lexer-tripping plain scalars quoted. See
// quotePlainScalars in schema.ts.
test("recovers an acceptance bullet starting with a backtick (reserved-character footgun)", () => {
  const content = [
    "---",
    "title: CLI Calculator",
    "priority: 0",
    "acceptance:",
    "  - Binary accepts `calc <a> <op> <b>` positional args",
    "  - Exits with non-zero + error message on: wrong arg count, invalid number",
    "  - `calc --help` prints usage",
    "---",
    "Build a TypeScript CLI calculator.",
  ].join("\n")
  const task = parseTask("q8m3-cli-calculator.md", content, "/p/q8m3-cli-calculator.md")
  assert.equal(task.title, "CLI Calculator")
  assert.equal(task.priority, 0, "the repair must not stringify numeric fields")
  assert.deepEqual(task.acceptance, [
    "Binary accepts `calc <a> <op> <b>` positional args",
    "Exits with non-zero + error message on: wrong arg count, invalid number",
    "`calc --help` prints usage",
  ])
})

test("recovers a list item starting with a reserved character, leaves quoted values alone", () => {
  // Control: already-quoted values are valid YAML — parsed first try, never rewritten.
  const quoted = ["---", "title: t", "labels:", "  - '*hot*'", "---", "b"].join("\n")
  assert.deepEqual(parseTask("t.md", quoted, "/p").labels, ["*hot*"])
  const broken = ["---", "title: t", "labels:", "  - @jdoe", "---", "b"].join("\n")
  assert.deepEqual(parseTask("t.md", broken, "/p").labels, ["@jdoe"])
})

test("still throws the original error when the repair cannot rescue the YAML", () => {
  assert.throws(() => parseTask("t.md", "---\ntitle: : :\n  bad: indent\n---\nb", "/p"), /invalid YAML frontmatter/)
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

/** A deterministic `mint` stub that yields the given short ids in order. */
const mintSeq = (...ids: string[]) => {
  let i = 0
  return () => ids[Math.min(i++, ids.length - 1)]!
}

test("buildTaskFile prefixes a short hash to the readable slug", () => {
  const file = buildTaskFile({ title: "Add a foo helper" }, [], mintSeq("f7k3"))
  assert.equal(file.id, "f7k3-add-a-foo-helper")
  assert.equal(file.filename, "f7k3-add-a-foo-helper.md")
  assert.match(file.content, /title: Add a foo helper/)
})

test("buildTaskFile re-rolls the short id when the combined id is taken", () => {
  // First mint clashes with an existing id; the second is free.
  const file = buildTaskFile({ title: "Foo" }, ["aaaa-foo"], mintSeq("aaaa", "bbbb"))
  assert.equal(file.id, "bbbb-foo")
})

test("buildTaskFile falls back to a numeric suffix if the short id keeps clashing", () => {
  // A stub that never varies (or an exhausted RNG) can't free the hash — the write
  // still needs a unique FILE, so the slug gets a numeric suffix and the loop terminates.
  const file = buildTaskFile({ title: "Foo" }, ["aaaa-foo"], mintSeq("aaaa"))
  assert.equal(file.id, "aaaa-foo-0")
})

test("buildTaskFile re-rolls when the short hash is taken even by a different slug", () => {
  // f7k3 already belongs to an unrelated task; the new task must NOT reuse the hash,
  // so a human typing `f7k3` always targets exactly one task (Fix C).
  const file = buildTaskFile({ title: "Bar" }, ["f7k3-something-else"], mintSeq("f7k3", "a1b2"))
  assert.equal(file.id, "a1b2-bar")
  assert.equal(shortIdOf(file.id), "a1b2")
})

test("buildTaskFile falls back to 'task' when the title has no slug chars", () => {
  assert.equal(buildTaskFile({ title: "!!!" }, [], mintSeq("f7k3")).id, "f7k3-task")
})

test("shortIdOf returns the leading hash of a modern id, else the whole id", () => {
  assert.equal(shortIdOf("f7k3-add-a-foo-helper"), "f7k3")
  assert.equal(shortIdOf("a1b2-x"), "a1b2")
  // Legacy slug ids have a hyphen inside the first four chars → returned whole.
  assert.equal(shortIdOf("add-rate-limiting"), "add-rate-limiting")
  assert.equal(shortIdOf("foo"), "foo")
})

test("mintShortId yields SHORT_ID_LEN base36 chars with no hyphen", () => {
  // A seeded RNG makes the output deterministic.
  let n = 0
  const rand = () => ((n = (n * 9301 + 49297) % 233280), n / 233280)
  const id = mintShortId(rand)
  assert.equal(id.length, SHORT_ID_LEN)
  assert.match(id, /^[a-z0-9]+$/)
  assert.doesNotMatch(id, /-/)
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
