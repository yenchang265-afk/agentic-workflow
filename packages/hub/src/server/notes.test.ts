import assert from "node:assert/strict"
import { test } from "node:test"
import { extractAuditNotes, missingNotes } from "./notes.js"

test("extractAuditNotes parses stamped audit blockquotes", () => {
  const body = [
    "Some intro text.",
    "> Task approved — queued [2026-07-01T10:00:00.000Z by alice]",
    "",
    "## Implementation Plan",
    "- step one",
    "> VERIFY verdict: PASS — all good (iteration 1) [2026-07-02T11:30:00.000Z by loop]",
  ].join("\n")
  assert.deepEqual(extractAuditNotes(body), [
    { event: "Task approved — queued", at: "2026-07-01T10:00:00.000Z", by: "alice" },
    { event: "VERIFY verdict: PASS — all good (iteration 1)", at: "2026-07-02T11:30:00.000Z", by: "loop" },
  ])
})

test("extractAuditNotes keeps unstamped blockquotes with empty stamp", () => {
  const notes = extractAuditNotes("> BUILD started (iteration 1)\nplain line")
  assert.deepEqual(notes, [{ event: "BUILD started (iteration 1)", at: "", by: "" }])
})

test("extractAuditNotes returns [] for a body without blockquotes", () => {
  assert.deepEqual(extractAuditNotes("just\nmarkdown\n- list"), [])
})

// --- missingNotes: the backstop for a note the editor could reach ---

test("missingNotes catches an audit line an edit deleted", () => {
  const before = "Intro.\n> BUILD started [t by a]\nMore prose."
  assert.deepEqual(missingNotes(before, "Intro.\nMore prose."), ["> BUILD started [t by a]"])
})

test("missingNotes is empty when the trail survives, however the prose changed", () => {
  const before = "Intro.\n> BUILD started [t by a]\nMore."
  assert.deepEqual(missingNotes(before, "Rewritten.\n> BUILD started [t by a]"), [])
  assert.deepEqual(missingNotes("no notes here", "still none"), [])
})

test("missingNotes tolerates reordering — each event is still recorded", () => {
  // A documented limit of the set comparison: the notes carry their own
  // timestamps, so order is not what makes the trail trustworthy.
  const before = "> one [t by a]\n> two [t by a]"
  assert.deepEqual(missingNotes(before, "> two [t by a]\n> one [t by a]"), [])
})
