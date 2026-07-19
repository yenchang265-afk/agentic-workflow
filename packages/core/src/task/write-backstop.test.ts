import assert from "node:assert/strict"
import { test } from "node:test"
import {
  chainedAdoWriteBackstopViolation,
  chainedGithubPrMutation,
  chainedGitPushViolation,
  isAdoWriteBackstopViolation,
  isGithubPrMutation,
  isGitPushViolation,
  splitSegments,
} from "./write-backstop.js"

/**
 * Vectors shared with the twin `plugins/claude/hooks/src/allowlist.mjs`
 * (tested in plugins/claude/hooks/check-stage-guard.test.mjs) — keep the two
 * suites in sync so the classifiers can't drift between hosts.
 */

const ADO_PRS = "https://dev.azure.com/org/proj/_apis/git/repositories/abc/pullRequests"

test("splitSegments splits on unquoted operators only", () => {
  assert.deepEqual(splitSegments("git status && git diff"), ["git status", "git diff"])
  assert.deepEqual(splitSegments(`gh pr comment 1 --body "fixed A && B"`), [`gh pr comment 1 --body "fixed A && B"`])
  assert.deepEqual(splitSegments("a; b | c"), ["a", "b", "c"])
})

test("isGithubPrMutation flags PR state changes and the merge REST route", () => {
  assert.equal(isGithubPrMutation("gh pr merge 12"), true)
  assert.equal(isGithubPrMutation("gh pr close 12"), true)
  assert.equal(isGithubPrMutation("gh pr review --approve 12"), true)
  assert.equal(isGithubPrMutation("gh api -X PUT repos/o/r/pulls/12/merge"), true)
  assert.equal(isGithubPrMutation("gh api --method DELETE repos/o/r/issues/1/comments/9"), true)
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/merge -X PUT"), true)
})

test("isGithubPrMutation flags review submissions, including the POST implied by a body flag", () => {
  assert.equal(isGithubPrMutation("gh api -X POST repos/o/r/pulls/12/reviews -f event=APPROVE"), true)
  // No -X at all: -f makes gh send POST — the implicit-POST hole.
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/reviews -f event=APPROVE"), true)
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/requested_reviewers -F 'reviewers[]=x'"), true)
  // GET reads of reviews stay allowed.
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/reviews"), false)
})

test("isGithubPrMutation allows reads and comment replies", () => {
  assert.equal(isGithubPrMutation("gh pr comment 12 --body done"), false)
  assert.equal(isGithubPrMutation("gh pr view 12"), false)
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12"), false)
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/comments -f body=done"), false)
  assert.equal(isGithubPrMutation("gh api repos/o/r/pulls/12/comments/9/replies -f body=done"), false)
})

test("isAdoWriteBackstopViolation allows GET reads, thread replies, and creating a PR", () => {
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" "${ADO_PRS}/123?api-version=7.1"`), false)
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" -X POST -d '{}' "${ADO_PRS}/123/threads/9/comments?api-version=7.1"`), false)
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" -d '{"isDraft":true}' "${ADO_PRS}?api-version=7.1"`), false)
})

test("isAdoWriteBackstopViolation blocks completes, votes, and non-thread POSTs", () => {
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" -X PATCH -d '{}' "${ADO_PRS}/123?api-version=7.1"`), true)
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" -X PUT -d '{}' "${ADO_PRS}/123/reviewers/me?api-version=7.1"`), true)
  assert.equal(isAdoWriteBackstopViolation(`curl -sS -u :"$PAT" -X POST -d '{}' "${ADO_PRS}/123/reviewers?api-version=7.1"`), true)
})

test("isGitPushViolation flags force, delete, cross-branch, and default-branch pushes", () => {
  assert.equal(isGitPushViolation("git push --force origin feature/x"), true)
  assert.equal(isGitPushViolation("git push origin :feature/x"), true)
  assert.equal(isGitPushViolation("git push origin +feature/x"), true)
  assert.equal(isGitPushViolation("git push origin x:main"), true)
  assert.equal(isGitPushViolation("git push origin x:refs/heads/main"), true)
  // Fast-forward pushes of the default branch (or a statically unresolvable HEAD).
  assert.equal(isGitPushViolation("git push origin main"), true)
  assert.equal(isGitPushViolation("git push origin master"), true)
  assert.equal(isGitPushViolation("git push origin refs/heads/main"), true)
  assert.equal(isGitPushViolation("git push origin HEAD"), true)
  assert.equal(isGitPushViolation("git push origin main:main"), true)
  assert.equal(isGitPushViolation("git -C /repo push origin main"), true)
})

test("isGitPushViolation allows a fast-forward push of an arbitrary head branch", () => {
  assert.equal(isGitPushViolation("git push origin feature/x"), false)
  assert.equal(isGitPushViolation("git push origin pr-head-branch"), false)
  assert.equal(isGitPushViolation("git push origin feature/x:refs/heads/feature/x"), false)
  assert.equal(isGitPushViolation("git -C /repo push origin main-sitter/fix-1"), false)
  assert.equal(isGitPushViolation("git status"), false)
})

test("chained variants catch a mutation hidden behind an allowed read", () => {
  assert.equal(chainedGithubPrMutation("gh pr view 12 && gh api -X PUT repos/o/r/pulls/12/merge"), true)
  assert.equal(chainedGithubPrMutation("gh pr view 12 && gh pr comment 12 --body ok"), false)
  assert.equal(chainedGitPushViolation("git status && git push --force origin x"), true)
  assert.equal(chainedAdoWriteBackstopViolation(`curl -sS "${ADO_PRS}/1" && curl -X PATCH -d '{}' "${ADO_PRS}/1"`), true)
})
