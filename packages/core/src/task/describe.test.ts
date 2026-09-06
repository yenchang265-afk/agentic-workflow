import assert from "node:assert/strict"
import { test } from "node:test"
import { describeTask, extractAuditNotes, formatTaskDescription, SHOWN_NOTES } from "./describe.js"
import { parseTask, serializeTask } from "./schema.js"
import { PLAN_HEADING } from "./store.js"

const parsed = (body: string, extra: Record<string, unknown> = {}) =>
  parseTask("t.md", serializeTask({ title: "Do it", body, ...extra }), "/repo/docs/tasks/queued/t.md")

test("extractAuditNotes keeps stamped and plain blockquotes in order", () => {
  const notes = extractAuditNotes("prose\n> Plain note\n> Stamped [2026-01-01T00:00:00.000Z by dev]\nmore\n>   spaced   [2026-01-02T00:00:00.000Z by  loop ]")
  assert.deepEqual(notes, [
    { event: "Plain note", at: "", by: "" },
    { event: "Stamped", at: "2026-01-01T00:00:00.000Z", by: "dev" },
    { event: "spaced", at: "2026-01-02T00:00:00.000Z", by: "loop " },
  ])
  assert.deepEqual(extractAuditNotes("no notes"), [])
})

test("describeTask omits every absent optional key and derives flags by the gates' own parsers", () => {
  const bare = describeTask(parsed("context"), "queued")
  assert.deepEqual(Object.keys(bare).sort(), ["acceptance", "blockedBy", "claimable", "claimed", "hasPlan", "id", "interrupted", "labels", "notes", "path", "priority", "status", "title"])
  assert.equal(bare.hasPlan, false)
  assert.equal(bare.claimable, false)
  const ready = describeTask(parsed(`${PLAN_HEADING}\n\n1. Go.\n\n> Plan approved [2026-01-01T00:00:00.000Z by dev]`), "in-progress")
  assert.equal(ready.claimable, true)
  assert.equal(ready.interrupted, false, "a snapshot-less, claimable task is not interrupted")
  assert.equal(describeTask(parsed(`${PLAN_HEADING}\n\n1. Go.\n\n> Plan approved [2026-01-01T00:00:00.000Z by dev]`), "in-progress", { claimed: true }).claimable, false)
  // A snapshot names a non-claimable in-progress task: interrupted (design 53's rule).
  const died = describeTask(parsed(`${PLAN_HEADING}\n\n1. Go.\n\n> Plan approved [2026-01-01T00:00:00.000Z by dev]\n> CLAIMED — loop starting [2026-01-01T00:01:00.000Z by loop]\n> BUILD started (iteration 1) [2026-01-01T00:02:00.000Z by loop]\n> BUILD finished (iteration 1) [2026-01-01T00:03:00.000Z by loop]`), "in-progress", { snapshot: true })
  assert.equal(died.interrupted, true)
  // Same body without the snapshot: BUILD finished, so the body alone says not interrupted.
  assert.equal(describeTask(parsed(`${PLAN_HEADING}\n\n1. Go.\n\n> Plan approved [2026-01-01T00:00:00.000Z by dev]\n> CLAIMED — loop starting [2026-01-01T00:01:00.000Z by loop]\n> BUILD started (iteration 1) [2026-01-01T00:02:00.000Z by loop]\n> BUILD finished (iteration 1) [2026-01-01T00:03:00.000Z by loop]`), "in-progress").interrupted, false)
  // Outside in-progress neither flag applies, whatever the body says.
  assert.equal(describeTask(parsed(`${PLAN_HEADING}\n\n1. Go.\n\n> Plan approved [2026-01-01T00:00:00.000Z by dev]`), "in-review", { snapshot: true }).interrupted, false)
})

test("describeTask carries the replan reason, stop context, prior run and abandon origin", () => {
  const body =
    `${PLAN_HEADING}\n\n1. Old.\n\n` +
    `> Plan rejected — sent back to queued for re-planning — wrong approach [2026-01-01T00:00:00.000Z by dev]\n` +
    `> Prior work — on branch feature/t, base main; diff: 2 files changed, 3 insertions(+) [2026-01-01T00:00:01.000Z by dev]\n` +
    `> Run stopped — attempts: iteration 1 VERIFY FAIL: red [2026-01-01T00:00:02.000Z by dev]\n`
  const d = describeTask(parsed(body), "queued")
  assert.equal(d.replanReason, "wrong approach")
  assert.equal(d.stopContext, "iteration 1 VERIFY FAIL: red")
  assert.equal(d.priorRun?.branch, "feature/t")
  assert.equal(d.priorRun?.diffstat, "2 files changed, 3 insertions(+)")
  const gone = describeTask(parsed("c\n\n> Abandoned from in-review — parked [2026-01-01T00:00:00.000Z by dev]"), "abandoned")
  assert.equal(gone.abandonedFrom, "in-review")
  // The origin is read only for an abandoned task — the same note on a restored draft is history.
  assert.equal("abandonedFrom" in describeTask(parsed("c\n\n> Abandoned from in-review [2026-01-01T00:00:00.000Z by dev]"), "draft"), false)
})

test("formatTaskDescription renders the head line, the sections that apply, and a capped audit tail", () => {
  const notes = Array.from({ length: SHOWN_NOTES + 3 }, (_, i) => `> note ${String(i)} [2026-01-01T00:00:0${String(i % 10)}.000Z by dev]`).join("\n")
  const d = describeTask(parsed(`context\n\n${notes}`, { priority: 4, type: "bug", labels: ["api", "perf"], acceptance: ["A", "B"], epic: "e1-epic", blockedBy: ["b1"] }), "queued")
  const lines = formatTaskDescription(d)
  assert.equal(lines[0], "t — queued/ · priority 4 · bug")
  assert.equal(lines[1], "  Do it")
  assert.ok(lines.includes("  epic: e1-epic"))
  assert.ok(lines.includes("  blocked by: b1"))
  assert.ok(lines.includes("  labels: api, perf"))
  assert.ok(lines.includes("  acceptance (2):"))
  assert.ok(lines.includes(`  audit trail (3 earlier not shown):`))
  assert.ok(lines.some((l) => l.endsWith(`note ${String(SHOWN_NOTES + 2)} [dev]`)), "newest note last")
  assert.ok(!lines.some((l) => l.includes("note 0 ")), "the oldest are counted, not printed")
  assert.equal(lines.at(-1), "  file: /repo/docs/tasks/queued/t.md")
  // A bare task renders no optional section at all.
  const bare = formatTaskDescription(describeTask(parsed("context"), "draft"))
  assert.deepEqual(bare, ["t — draft/ · priority 0", "  Do it", "  file: /repo/docs/tasks/queued/t.md"])
})
