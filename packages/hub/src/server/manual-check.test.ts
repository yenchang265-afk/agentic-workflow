import assert from "node:assert/strict"
import { test } from "node:test"
import { checkFreshness, extractMentions, parseArgumentHint, type CommandSurface } from "./manual-check.js"

test("parseArgumentHint takes the first token of each segment", () => {
  assert.deepEqual(
    parseArgumentHint("---\nargument-hint: new <idea> | retask <id> [note] | approve [id] | watch [interval] | status\n---"),
    ["new", "retask", "approve", "watch", "status"],
  )
  assert.deepEqual(parseArgumentHint("---\ndescription: nothing\n---"), [])
})

test("extractMentions finds kind+verb pairs once each, ignoring trailing prose", () => {
  const html = `<code>/agentic-loop:engineering approve</code> then /agentic-loop:engineering approve again,
    /agentic-loop:engineering watch, bare /agentic-loop:pr-sitter too`
  const known = new Set(["approve", "watch"])
  assert.deepEqual(extractMentions(html, known), [
    { kind: "engineering", verb: "approve" },
    { kind: "engineering", verb: "watch" },
    { kind: "pr-sitter", verb: "" }, // "too" is prose, not a verb
  ])
})

const surfaces: CommandSurface[] = [
  { kind: "engineering", host: "opencode", verbs: ["new", "approve", "watch", "status"] },
  { kind: "engineering", host: "claude", verbs: ["new", "approve", "status"] },
  { kind: "pr-sitter", host: "opencode", verbs: ["claim"] },
  { kind: "pr-sitter", host: "claude", verbs: ["claim"] },
]

test("checkFreshness flags host-partial verbs, unknown kinds, and undocumented verbs", () => {
  const warnings = checkFreshness(
    [
      { kind: "engineering", verb: "watch" }, // opencode-only
      { kind: "legacy-loop", verb: "" }, // unknown kind
      { kind: "engineering", verb: "approve" }, // fine
    ],
    surfaces,
  )
  assert.ok(warnings.some((w) => w.includes("watch") && w.includes("only exists on opencode")))
  assert.ok(warnings.some((w) => w.includes("legacy-loop")))
  // undocumented: new, status, claim
  assert.ok(warnings.some((w) => w.includes("engineering new")))
  assert.ok(warnings.some((w) => w.includes("pr-sitter claim")))
  assert.ok(!warnings.some((w) => w.includes("approve")))
})

test("checkFreshness is quiet when manual and surface agree", () => {
  const warnings = checkFreshness(
    [
      { kind: "pr-sitter", verb: "claim" },
      { kind: "engineering", verb: "new" },
      { kind: "engineering", verb: "approve" },
      { kind: "engineering", verb: "status" },
      { kind: "engineering", verb: "watch" },
    ],
    [
      { kind: "engineering", host: "opencode", verbs: ["new", "approve", "status", "watch"] },
      { kind: "pr-sitter", host: "opencode", verbs: ["claim"] },
    ],
  )
  assert.deepEqual(warnings, [])
})
