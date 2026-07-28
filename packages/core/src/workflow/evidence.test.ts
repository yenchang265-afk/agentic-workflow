import assert from "node:assert/strict"
import { test } from "node:test"
import {
  itemObserved,
  mergeEvidence,
  NO_OBSERVATIONS,
  observedNothing,
  substantiated,
  unobservedItems,
  type EvidenceItem,
  type ObservedEvidence,
} from "./evidence.js"

const observed = (commands: string[], reads: string[] = []): ObservedEvidence => ({ commands, reads })
const cmd = (ref: string): EvidenceItem => ({ kind: "command", ref })
const file = (ref: string): EvidenceItem => ({ kind: "file", ref })

// --- command matching ---

test("a cited command matches the pinned form the guard actually ran", () => {
  // The worktree pin rewrites a bare `npm test` into `cd <worktree> && npm test`
  // before it runs: the agent declares what it typed, the host observes what
  // executed, and containment is what makes both accounts of one command match.
  assert.ok(itemObserved(cmd("npm test"), observed(["cd /repo/.worktrees/wf-1 && npm test"])))
  assert.ok(itemObserved(cmd("cd /repo/.worktrees/wf-1 && npm test"), observed(["npm test"])))
})

test("command matching ignores case and whitespace, not identity", () => {
  assert.ok(itemObserved(cmd("NPM   test"), observed(["npm test"])))
  assert.equal(itemObserved(cmd("npm test"), observed(["npm run lint"])), false)
})

test("an empty citation matches nothing — it must not sneak through containment", () => {
  // "" is a substring of every string; without the guard an empty ref would
  // corroborate itself against any command at all.
  assert.equal(itemObserved(cmd("   "), observed(["npm test"])), false)
  assert.equal(itemObserved(cmd("npm test"), observed(["  "])), false)
})

// --- file matching ---

test("a cited path matches the absolute path the host observed, at a segment boundary", () => {
  assert.ok(itemObserved(file("src/limit.ts"), observed([], ["/repo/.worktrees/wf-1/src/limit.ts"])))
  // Not a segment boundary: `notsrc/limit.ts` merely ends with the same characters.
  assert.equal(itemObserved(file("src/limit.ts"), observed([], ["/repo/other/notsrc/limit.ts"])), false)
})

test("a cited path drops its file:line suffix before matching", () => {
  assert.ok(itemObserved(file("src/limit.ts:88"), observed([], ["/repo/src/limit.ts"])))
  assert.ok(itemObserved(file("src/limit.ts:88:12"), observed([], ["/repo/src/limit.ts"])))
})

test("windows separators normalize to posix", () => {
  assert.ok(itemObserved(file("src\\limit.ts"), observed([], ["/repo/src/limit.ts"])))
})

test("a file read through the shell counts as a read", () => {
  // Rejecting `cat src/limit.ts` would push stages toward whichever tool happens
  // to be logged rather than the one that fits the job.
  assert.ok(itemObserved(file("src/limit.ts"), observed(["cat src/limit.ts"])))
  assert.ok(itemObserved(file("src/limit.ts"), observed(["git diff -- src/limit.ts"])))
  assert.equal(itemObserved(file("src/limit.ts"), observed(["git status"])), false)
})

// --- the rule ---

test("substantiated needs ONE corroborated citation, not all of them", () => {
  // Deliberately loose: a check stage that cannot record a verdict burns its
  // retry and ERROR-stops the loop, so a false rejection costs more than an
  // over-generous match. See `substantiated`.
  const declared = [cmd("npm test"), file("src/never-read.ts")]
  assert.ok(substantiated(declared, observed(["npm test"])))
  assert.deepEqual(unobservedItems(declared, observed(["npm test"])), [file("src/never-read.ts")])
})

test("substantiated is false when nothing cited was observed", () => {
  assert.equal(substantiated([cmd("npm test"), file("a.ts")], observed(["git status"], ["/repo/b.ts"])), false)
  assert.equal(substantiated([], observed(["npm test"])), false)
})

test("observedNothing separates 'did nothing' from 'not recorded'", () => {
  assert.ok(observedNothing(NO_OBSERVATIONS))
  assert.equal(observedNothing(observed([], ["/repo/a.ts"])), false)
})

// --- accumulation ---

test("mergeEvidence de-dupes across repeat calls in one stage", () => {
  const merged = mergeEvidence([cmd("npm test")], [{ kind: "command", ref: "NPM  TEST", result: "42 passed" }, file("a.ts")])
  assert.deepEqual(
    merged.map((i) => i.ref),
    ["npm test", "a.ts"],
  )
})

test("mergeEvidence keeps a command and a file of the same name apart", () => {
  assert.equal(mergeEvidence([cmd("a.ts")], [file("a.ts")]).length, 2)
})

test("mergeEvidence treats undefined sides as empty", () => {
  assert.deepEqual(mergeEvidence(undefined, undefined), [])
  assert.equal(mergeEvidence(undefined, [cmd("npm test")]).length, 1)
})
