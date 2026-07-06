import assert from "node:assert/strict"
import { test } from "node:test"
import type { WorkItem, WorkSource } from "../source/types.js"
import { combineSkips, pollOnce } from "./scheduler.js"

const item = (id: string, loopKind: string): WorkItem => ({
  id,
  loopKind,
  title: id,
  entryStage: "build",
  state: { kind: loopKind, goal: id, stage: "build", iteration: 0, artifacts: {} },
  claimMessage: `claimed ${id}`,
})

const source = (
  loopKind: string,
  next: WorkItem | null,
  skip = { message: `${loopKind}: nothing`, actionable: false },
): WorkSource & { released: string[]; polls: number } => {
  const s = {
    loopKind,
    released: [] as string[],
    polls: 0,
    async claimNext() {
      s.polls++
      return next ? { item: next, skip: null } : { item: null, skip }
    },
    async release(w: WorkItem) {
      s.released.push(w.id)
    },
  }
  return s
}

test("pollOnce claims from the first source with work and never polls later ones", async () => {
  const a = source("eng", item("t1", "eng"))
  const b = source("pr-sitter", item("pr-9", "pr-sitter"))
  const { claim, skips } = await pollOnce([a, b])
  assert.equal(claim?.item.id, "t1")
  assert.equal(claim?.source.loopKind, "eng")
  assert.equal(b.polls, 0)
  assert.deepEqual(skips, [])
})

test("pollOnce falls through empty sources, collecting their skip reasons", async () => {
  const a = source("eng", null, { message: "eng: empty", actionable: false })
  const b = source("pr-sitter", item("pr-9", "pr-sitter"))
  const { claim, skips } = await pollOnce([a, b])
  assert.equal(claim?.item.id, "pr-9")
  assert.deepEqual(
    skips.map((s) => s.message),
    ["eng: empty"],
  )
})

test("pollOnce with nothing anywhere returns every skip reason", async () => {
  const a = source("eng", null, { message: "eng: empty", actionable: false })
  const b = source("pr-sitter", null, { message: "pr: held", actionable: true })
  const { claim, skips } = await pollOnce([a, b])
  assert.equal(claim, null)
  assert.equal(skips.length, 2)
})

test("combineSkips merges messages and ORs actionability", () => {
  assert.equal(combineSkips([]), null)
  assert.deepEqual(combineSkips([{ message: "a", actionable: false }]), { message: "a", actionable: false })
  assert.deepEqual(
    combineSkips([
      { message: "a", actionable: false },
      { message: "b", actionable: true },
    ]),
    { message: "a · b", actionable: true },
  )
})
