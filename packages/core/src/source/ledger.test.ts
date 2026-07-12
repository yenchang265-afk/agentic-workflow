import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { attentionTriggers, emptyLedger, ledgerPath, type PrLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"

const ALL: readonly PrTrigger[] = ["failing-checks", "changes-requested", "new-comments", "merge-conflict"]

const snap = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  title: "t",
  headRefName: "feat/x",
  baseRefName: "main",
  headRefOid: "sha-1",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  failingChecks: [],
  newComments: [],
  ...over,
})

const ledger = (over: Partial<PrLedger> = {}): PrLedger => ({ ...emptyLedger(7, "2026-01-01T00:00:00Z"), ...over })

test("a quiet green PR triggers nothing", () => {
  assert.deepEqual(attentionTriggers(snap(), ledger(), ALL), [])
})

test("failing checks trigger on an unhandled head only", () => {
  const s = snap({ failingChecks: ["ci"] })
  assert.deepEqual(attentionTriggers(s, ledger(), ALL), ["failing-checks"])
  assert.deepEqual(attentionTriggers(s, ledger({ headShaHandled: "sha-1" }), ALL), [])
  assert.deepEqual(attentionTriggers(s, ledger({ headShaHandled: "older" }), ALL), ["failing-checks"])
})

test("the sitter's own push suppresses check/review re-triggering, but a genuinely-new comment still fires", () => {
  // headShaHandled = the sitter's push. failing-checks/changes-requested are the
  // same head → suppressed. newComments is watermark-filtered, so its presence
  // means a comment arrived AFTER the push → it must still trigger (B6).
  const s = snap({ failingChecks: ["ci"], reviewDecision: "CHANGES_REQUESTED", newComments: [{ author: "alice", at: "2026-01-02T00:00:00Z" }] })
  assert.deepEqual(attentionTriggers(s, ledger({ headShaHandled: "sha-1" }), ALL), ["new-comments"])
  // Same head, no new comment → nothing.
  assert.deepEqual(attentionTriggers(snap({ failingChecks: ["ci"] }), ledger({ headShaHandled: "sha-1" }), ALL), [])
})

test("a failed attempt parks the PR until the head changes — including new comments", () => {
  const s = snap({ failingChecks: ["ci"], newComments: [{ author: "alice", at: "2026-01-02T00:00:00Z" }] })
  const l = ledger({ failedAttempts: [{ headSha: "sha-1", trigger: "failing-checks", at: "2026-01-01T01:00:00Z" }] })
  // A cap does NOT advance the comment watermark, so the triggering comment is
  // still in the snapshot; new-comments must stay suppressed to avoid re-claim →
  // re-fail forever. Checks stay suppressed too.
  assert.deepEqual(attentionTriggers(s, l, ALL), [])
  assert.deepEqual(attentionTriggers(snap({ failingChecks: ["ci"], newComments: [{ author: "alice", at: "2026-01-02T00:00:00Z" }], headRefOid: "sha-2" }), l, ALL), ["failing-checks", "new-comments"])
})

test("new comments come pre-filtered; presence triggers, watermark handled upstream", () => {
  const s = snap({ newComments: [{ author: "alice", at: "2026-01-02T00:00:00Z" }] })
  assert.deepEqual(attentionTriggers(s, ledger(), ALL), ["new-comments"])
})

test("a conflict triggers once per (head, base) pair", () => {
  const s = snap({ mergeable: "CONFLICTING" })
  assert.deepEqual(attentionTriggers(s, ledger(), ALL), ["merge-conflict"])
  const attempted = ledger({ conflictAttempt: { headSha: "sha-1", baseSha: "base-1" } })
  assert.deepEqual(attentionTriggers(s, attempted, ALL, "base-1"), [])
  assert.deepEqual(attentionTriggers(s, attempted, ALL, "base-2"), ["merge-conflict"])
})

test("disabled triggers never fire", () => {
  const s = snap({ failingChecks: ["ci"], mergeable: "CONFLICTING" })
  assert.deepEqual(attentionTriggers(s, ledger(), ["new-comments"]), [])
})

test("review-requested fires once per head: unhandled head triggers, handled/failed heads don't, a new push re-fires", () => {
  const enabled: readonly PrTrigger[] = ["review-requested"]
  // A quiet PR the query matched (review wanted) needs exactly one review pass.
  assert.deepEqual(attentionTriggers(snap(), ledger(), enabled), ["review-requested"])
  // The kind's own terminal recorded this head — no re-review until a human pushes.
  assert.deepEqual(attentionTriggers(snap(), ledger({ headShaHandled: "sha-1" }), enabled), [])
  // A capped/failed attempt on this head parks it the same way.
  const failed = ledger({ failedAttempts: [{ headSha: "sha-1", trigger: "review-requested", at: "2026-01-01T01:00:00Z" }] })
  assert.deepEqual(attentionTriggers(snap(), failed, enabled), [])
  // A new head (human push) re-fires.
  assert.deepEqual(attentionTriggers(snap({ headRefOid: "sha-2" }), ledger({ headShaHandled: "sha-1" }), enabled), ["review-requested"])
  // Not enabled ⇒ never fires (the author-role kinds don't opt in).
  assert.deepEqual(attentionTriggers(snap(), ledger(), ALL), [])
})

test("ledgers are namespaced per loop kind; pr-sitter's path is byte-identical to the pre-namespacing layout", () => {
  assert.equal(ledgerPath("/r", "docs/tasks", "pr-sitter", 7), path.join("/r", "docs/tasks", "runs", "pr-sitter", "pr-7.json"))
  assert.equal(ledgerPath("/r", "docs/tasks", "review-sitter", 7), path.join("/r", "docs/tasks", "runs", "review-sitter", "pr-7.json"))
})
