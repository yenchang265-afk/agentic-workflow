import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultWorkflowsDir } from "../manifest/dir.js"
import { loadManifest } from "../manifest/load.js"
import { emptyLedger, type PrSnapshot } from "./ledger.js"
import { prWorkItem, terminalLedgerUpdate, triggerSummary } from "./pr-shared.js"

/**
 * The platform-neutral PR-source pieces: the terminal ledger decision (THE
 * dedup rule both github-pr and ado-pr trust) and the WorkItem builder over
 * the real pr-sitter / review-sitter manifests.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const NOW = "2026-07-05T00:00:00Z"

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 7,
  title: "Fix the flux capacitor",
  headRefName: "feature/flux",
  baseRefName: "main",
  headRefOid: "aaa111",
  mergeable: "MERGEABLE",
  reviewDecision: "",
  failingChecks: ["CI"],
  newComments: [],
  ...over,
})

test("terminalLedgerUpdate(done) advances the handled head and comment watermark", () => {
  const ledger = emptyLedger(7, NOW)
  const updated = terminalLedgerUpdate(ledger, { kind: "done", message: "pushed" }, ["failing-checks"], "aaa111", "bbb222", "2026-07-05T01:00:00Z", NOW)
  assert.equal(updated.headShaHandled, "bbb222") // the re-read head — the sitter's own push
  assert.equal(updated.lastCommentAtHandled, "2026-07-05T01:00:00Z")
  assert.equal(updated.conflictAttempt, undefined)
})

test("terminalLedgerUpdate(done) on a merge-conflict trigger records the conflict attempt", () => {
  const updated = terminalLedgerUpdate(emptyLedger(7, NOW), { kind: "done", message: "resolved" }, ["merge-conflict"], "aaa111", "bbb222", "", NOW)
  assert.deepEqual(updated.conflictAttempt, { headSha: "bbb222", baseSha: "" })
  // An empty re-read watermark must not clobber an existing one with "".
  assert.equal(updated.lastCommentAtHandled, undefined)
})

test("a genuine stop records a failed attempt against the SNAPSHOT head; a retryable stop changes nothing (C2)", () => {
  const ledger = emptyLedger(7, NOW)
  const capped = terminalLedgerUpdate(ledger, { kind: "stop", message: "capped" }, ["failing-checks", "new-comments"], "aaa111", "bbb222", "", NOW)
  assert.deepEqual(capped.failedAttempts, [{ headSha: "aaa111", trigger: "failing-checks+new-comments", at: NOW }])
  assert.equal(capped.headShaHandled, undefined, "a failed run never advances the handled head")

  const retryable = terminalLedgerUpdate(ledger, { kind: "stop", message: "gh blip", retryable: true }, ["failing-checks"], "aaa111", "bbb222", "", NOW)
  assert.equal(retryable, ledger, "same object — the caller skips the save and the head stays claimable")
})

test("prWorkItem enters the pr-sitter's first stage with an author-role goal and reusable git refs", () => {
  const loaded = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  const item = prWorkItem(loaded, "github", snapshot(), ["failing-checks"])
  assert.equal(item.id, "pr-7")
  assert.equal(item.workflowKind, "pr-sitter")
  assert.equal(item.entryStage, loaded.manifest.stages[0]?.name)
  assert.deepEqual(item.state.git, { base: "main", branch: "feature/flux" })
  assert.match(item.state.goal, /Never merge the PR/)
  assert.match(item.claimMessage, /failing checks: CI/)
})

test("prWorkItem gives a reviewer-role kind a comment-only goal", () => {
  const loaded = loadManifest(WORKFLOWS_DIR, "review-sitter")
  const item = prWorkItem(loaded, "github", snapshot(), ["review-requested"])
  assert.match(item.state.goal, /Never approve, request changes, or merge/)
  assert.equal(item.workflowKind, "review-sitter")
})

test("triggerSummary names every trigger in a human line", () => {
  const s = triggerSummary(["failing-checks", "changes-requested", "new-comments", "merge-conflict", "review-requested"], snapshot({ newComments: [{ author: "alice", at: NOW }] }))
  assert.match(s, /failing checks: CI/)
  assert.match(s, /review requested changes/)
  assert.match(s, /1 unanswered comment/)
  assert.match(s, /merge conflict/)
  assert.match(s, /your review is requested/)
})
