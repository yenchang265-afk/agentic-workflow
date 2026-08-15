import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildRecurringFile,
  parseRecurring,
  serializeRecurring,
  unknownRecurringKeys,
  type RecurringInput,
} from "./schema.js"

const DEF = `---
title: Weekly changelog digest
schedule:
  type: cron
  expression: "0 9 * * MON"
paused: false
acceptance:
  - A digest of merged PRs is posted
---
Summarize every PR merged since the last run.
`

test("parses a definition's frontmatter and body", () => {
  const def = parseRecurring("f7k3-digest.md", DEF, "/r/docs/recurring/f7k3-digest.md")
  assert.equal(def.id, "f7k3-digest")
  assert.equal(def.title, "Weekly changelog digest")
  assert.deepEqual(def.schedule, { type: "cron", expression: "0 9 * * MON" })
  assert.equal(def.paused, false)
  assert.deepEqual(def.acceptance, ["A digest of merged PRs is posted"])
  assert.equal(def.body, "Summarize every PR merged since the last run.")
})

test("an interval schedule parses too", () => {
  const src = `---\ntitle: Hourly sweep\nschedule:\n  type: interval\n  minutes: 60\n---\nDo the sweep.\n`
  const def = parseRecurring("a1b2-sweep.md", src, "/r/x.md")
  assert.deepEqual(def.schedule, { type: "interval", minutes: 60 })
  assert.equal(def.paused, false, "paused defaults to false")
})

test("a missing or malformed schedule is a readable, filename-prefixed error", () => {
  const noSchedule = `---\ntitle: Nope\n---\nbody\n`
  assert.throws(() => parseRecurring("x.md", noSchedule, "/r/x.md"), /x\.md: schedule/)

  const badType = `---\ntitle: Nope\nschedule:\n  type: weekly\n---\nbody\n`
  assert.throws(() => parseRecurring("x.md", badType, "/r/x.md"), /x\.md:/)

  const negative = `---\ntitle: Nope\nschedule:\n  type: interval\n  minutes: -5\n---\nbody\n`
  assert.throws(() => parseRecurring("x.md", negative, "/r/x.md"), /x\.md:/)
})

test("missing frontmatter is refused with the filename", () => {
  assert.throws(() => parseRecurring("x.md", "no frontmatter here", "/r/x.md"), /x\.md: missing YAML frontmatter/)
})

test("a colon-bearing acceptance bullet survives — the YAML footgun the backlog schema also tolerates", () => {
  // `- Dashboard shows: ticker, price` parses as a single-key MAP, not a string.
  const src = `---\ntitle: T\nschedule:\n  type: interval\n  minutes: 30\nacceptance:\n  - Dashboard shows: ticker, price\n---\nb\n`
  const def = parseRecurring("x.md", src, "/r/x.md")
  assert.deepEqual(def.acceptance, ["Dashboard shows: ticker, price"])
})

test("serialize round-trips through parse", () => {
  const input: RecurringInput = {
    title: "Weekly changelog digest",
    schedule: { type: "cron", expression: "0 9 * * MON" },
    paused: true,
    acceptance: ["A digest is posted"],
    body: "Summarize the merges.",
  }
  const def = parseRecurring("x.md", serializeRecurring(input), "/r/x.md")
  assert.equal(def.title, input.title)
  assert.deepEqual(def.schedule, input.schedule)
  assert.equal(def.paused, true)
  assert.deepEqual(def.acceptance, ["A digest is posted"])
  assert.equal(def.body, "Summarize the merges.")
})

test("unknownRecurringKeys names what a rewrite would delete", () => {
  // zod strips unknown keys, so serializing would silently drop these — the
  // caller refuses over them rather than losing a human's data.
  const withExtra = `---\ntitle: T\nschedule:\n  type: interval\n  minutes: 30\nowner: alice\nticket: ABC-1\n---\nb\n`
  assert.deepEqual(unknownRecurringKeys(withExtra).sort(), ["owner", "ticket"])
  assert.deepEqual(unknownRecurringKeys(DEF), [])
})

test("buildRecurringFile mints a <hash>-<slug> id that avoids collisions", () => {
  const input: RecurringInput = { title: "Weekly Digest!", schedule: { type: "interval", minutes: 60 } }
  const file = buildRecurringFile(input, [], () => "f7k3")
  assert.equal(file.id, "f7k3-weekly-digest")
  assert.equal(file.filename, "f7k3-weekly-digest.md")

  // A taken hash is re-rolled; a stub mint that cannot re-roll still yields a
  // unique FILE rather than clobbering the existing one.
  const second = buildRecurringFile(input, ["f7k3-weekly-digest"], () => "f7k3")
  assert.notEqual(second.id, "f7k3-weekly-digest")
})
