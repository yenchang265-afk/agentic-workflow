import assert from "node:assert/strict"
import { test } from "node:test"
import {
  boundaryIssue,
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

test("a sub-token citation does NOT corroborate — containment has a token floor", () => {
  // Raw substring containment had no floor in either direction, so a one-character
  // citation satisfied a gate whose whole job is to make a PASS provable:
  // `"npm test".includes("t")`. Containment is over contiguous TOKENS now.
  assert.equal(itemObserved(cmd("t"), observed(["npm test"])), false)
  assert.equal(itemObserved(cmd("es"), observed(["npm test"])), false)
  assert.equal(itemObserved(cmd("npm tes"), observed(["npm test"])), false)
  // A whole token that really is part of the command still counts.
  assert.ok(itemObserved(cmd("test"), observed(["npm test"])))
})

test("token containment must be CONTIGUOUS and in order", () => {
  // `npm lint` is not a run of `npm run lint`, even though both its tokens occur.
  assert.equal(itemObserved(cmd("npm lint"), observed(["npm run lint"])), false)
  assert.equal(itemObserved(cmd("test npm"), observed(["npm test"])), false)
  assert.ok(itemObserved(cmd("npm run lint"), observed(["cd /repo/wt && npm run lint --silent"])))
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
  // The worktree-absolute rewrite of the same read still matches, per token.
  assert.ok(itemObserved(file("src/limit.ts"), observed(["cat /repo/.worktrees/wf-1/src/limit.ts"])))
})

test("a cited file must be NAMED by a command, not merely spelled inside it", () => {
  // The old fallback asked whether the ref's basename occurred anywhere in the
  // command string — the same no-floor substring test, so `ref: "e"` matched
  // `npm test`. A token has to name the file now.
  assert.equal(itemObserved(file("e"), observed(["npm test"])), false)
  assert.equal(itemObserved(file("limit.ts"), observed(["echo no-limit.ts-here"])), false)
  assert.ok(itemObserved(file("limit.ts"), observed(["cat src/limit.ts"])))
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

// --- boundaryIssue: the diff-evidence narrowing (`requireDiffEvidence`) ---

const boundary = {
  files: ["src/db/query.ts", "src/api/limit.ts", "README.md"],
  diffCmd: "git -C /wt diff abc123...feature/t1",
}

test("a citation of a changed file admits the PASS — path or path:line, relative or worktree-absolute", () => {
  assert.equal(boundaryIssue([file("src/db/query.ts:41")], boundary, "review"), null)
  assert.equal(boundaryIssue([file("/wt/src/api/limit.ts")], boundary, "review"), null)
})

test("a command naming a changed file admits the PASS", () => {
  assert.equal(boundaryIssue([cmd("cat src/db/query.ts")], boundary, "review"), null)
  assert.equal(boundaryIssue([cmd("git -C /wt blame src/api/limit.ts")], boundary, "review"), null)
})

test("citing the diff command itself IS reviewing the boundary", () => {
  // A reviewer whose reading was `git diff` has reviewed the change; rejecting
  // that trades a fabricated PASS for a deadlocked loop.
  assert.equal(boundaryIssue([cmd("git -C /wt diff abc123...feature/t1")], boundary, "review"), null)
})

test("a PASS citing only unrelated work is rejected, and the rejection samples changed files to cite", () => {
  const issue = boundaryIssue([file("docs/other.md"), cmd("ls -la")], boundary, "review")
  assert.ok(issue)
  assert.match(issue ?? "", /touches the diff under review/)
  assert.match(issue ?? "", /src\/db\/query\.ts/)
  assert.match(issue ?? "", /git -C \/wt diff abc123\.\.\.feature\/t1/)
})
