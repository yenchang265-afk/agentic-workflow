import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  chainedFindMutation,
  chainedGithubPrMutation,
  chainedGitPushViolation,
  isAdoMcpToolOutOfStageScope,
  isAdoMcpWriteViolation,
  commandAllowed,
  isBareCd,
  isFindMutation,
  isGithubPrMutation,
  isGitPushViolation,
  matchesAny,
  splitSegments,
} from "./write-backstop.js"
import { withCommandPrefixes } from "../config-layers.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const findVectors: { mutating: string[]; readOnly: string[] } = JSON.parse(
  readFileSync(path.join(here, "..", "__fixtures__", "find-abuse-vectors.json"), "utf8"),
)

const admission: { globs: string[]; allowed: string[]; denied: string[]; prefixes: string[]; prefixAllowed: string[]; prefixDenied: string[] } = JSON.parse(
  readFileSync(path.join(here, "..", "__fixtures__", "allowlist-admission-vectors.json"), "utf8"),
)

/**
 * Vectors shared with the twin `plugins/claude/hooks/src/allowlist.mjs`
 * (tested in plugins/claude/hooks/check-stage-guard.test.mjs) — keep the two
 * suites in sync so the classifiers can't drift between hosts.
 */


test("commandAllowed agrees with its hook twin on every shared vector", () => {
  // core needs this to admit a plan-discovered check command
  // (`workflow/discovered-checks.ts`), the hook needs it to guard a stage
  // agent's bash. Same table both sides, or the twins drift silently.
  for (const cmd of admission.allowed) assert.equal(commandAllowed(cmd, admission.globs), true, `must allow: ${cmd}`)
  for (const cmd of admission.denied) assert.equal(commandAllowed(cmd, admission.globs), false, `must deny: ${cmd}`)
})

test("a configured proxy prefix re-expresses the boundary without dissolving it", () => {
  // The hosts stamp/append exactly this list, so the vectors run against it.
  const globs = withCommandPrefixes(admission.globs, admission.prefixes)
  for (const cmd of admission.prefixAllowed) assert.equal(commandAllowed(cmd, globs), true, `must allow: ${cmd}`)
  for (const cmd of admission.prefixDenied) {
    const denied = !commandAllowed(cmd, globs) || chainedFindMutation(cmd, admission.prefixes) || chainedGitPushViolation(cmd, admission.prefixes)
    assert.equal(denied, true, `must deny: ${cmd}`)
  }
})

test("the write backstops see through one proxy prefix — they anchor on the bare tool name", () => {
  // Verified against rtk 0.42.3: `git push --force origin main` is rewritten to
  // `rtk git push --force origin main` BEFORE either host evaluates anything, so
  // without the strip every classifier here reads it as no violation. The
  // allowlist cannot stand in — with the prefix configured, `rtk git push origin
  // main` matches a derived `rtk git push origin *` glob quite legitimately.
  const p = ["rtk"]
  assert.equal(chainedGitPushViolation("rtk git push --force origin main", p), true)
  assert.equal(chainedGitPushViolation("rtk git push origin main", p), true)
  assert.equal(chainedGitPushViolation("rtk git -C /wt push origin main", p), true)
  assert.equal(chainedGithubPrMutation("rtk gh pr merge 3", p), true)
  assert.equal(chainedGithubPrMutation("rtk gh pr view 3 && rtk gh api -X PUT repos/o/r/pulls/3/merge", p), true)
  assert.equal(chainedFindMutation("rtk find . -delete", p), true)
  // Not violations: the stage's real work still passes.
  assert.equal(chainedGitPushViolation("rtk git push origin feature/x", p), false)
  assert.equal(chainedGithubPrMutation("rtk gh pr view 3", p), false)
  assert.equal(chainedFindMutation("rtk find . -name '*.ts'", p), false)
  // Unset prefixes leave every classifier exactly as it was.
  assert.equal(chainedGitPushViolation("rtk git push --force origin main"), false)
  assert.equal(chainedGitPushViolation("git push --force origin main"), true)
  // One prefix being a prefix of another is the ordinary case (a proxy's escape
  // hatch lives under its own name), and stripping the SHORTER one first would
  // leave `proxy git push …` — unrecognizable to every classifier, while the
  // derived `rtk proxy git push origin *` glob admits the command.
  const both = ["rtk", "rtk proxy"]
  assert.equal(chainedGitPushViolation("rtk proxy git push origin main", both), true)
  assert.equal(chainedGithubPrMutation("rtk proxy gh pr merge 3", both), true)
  assert.equal(chainedFindMutation("rtk proxy find . -delete", both), true)
})

test("matchesAny anchors the whole segment and isBareCd rejects a cd with metacharacters", () => {
  // The globs compile with dotAll, so a trailing `*` already swallows anything
  // after it; the anchoring is what stops a PREFIX from matching.
  assert.equal(matchesAny("npm test", ["npm test*"]), true)
  assert.equal(matchesAny("xnpm test", ["npm test*"]), false)
  assert.equal(isBareCd("cd packages/web"), true)
  assert.equal(isBareCd("cd $(pwd)"), false)
  assert.equal(isBareCd("cd a && rm -rf /"), false)
})

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



test("isGitPushViolation flags force, delete, cross-branch, and default-branch pushes", () => {
  assert.equal(isGitPushViolation("git push --force origin feature/x"), true)
  assert.equal(isGitPushViolation("git push origin :feature/x"), true)
  // Short and bundled flag forms of force/delete — `-d` and `-fd` are
  // git-legal spellings of `--delete` / `--force --delete`.
  assert.equal(isGitPushViolation("git push -d origin feature/x"), true)
  assert.equal(isGitPushViolation("git push origin --delete feature/x"), true)
  assert.equal(isGitPushViolation("git push -fd origin feature/x"), true)
  assert.equal(isGitPushViolation("git push -df origin feature/x"), true)
  assert.equal(isGitPushViolation("git push --force-with-lease=refs/heads/x origin feature/x"), true)
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
  assert.equal(isGitPushViolation("git push -u origin feature/x"), false) // f/d-free short flag stays allowed
  assert.equal(isGitPushViolation("git push origin pr-head-branch"), false)
  assert.equal(isGitPushViolation("git push origin feature/x:refs/heads/feature/x"), false)
  assert.equal(isGitPushViolation("git -C /repo push origin main-sitter/fix-1"), false)
  assert.equal(isGitPushViolation("git status"), false)
})

test("chained variants catch a mutation hidden behind an allowed read", () => {
  assert.equal(chainedGithubPrMutation("gh pr view 12 && gh api -X PUT repos/o/r/pulls/12/merge"), true)
  assert.equal(chainedGithubPrMutation("gh pr view 12 && gh pr comment 12 --body ok"), false)
  assert.equal(chainedGitPushViolation("git status && git push --force origin x"), true)
})

test("isFindMutation rejects every shared abuse vector and passes every read-only one", () => {
  for (const cmd of findVectors.mutating) assert.equal(isFindMutation(cmd), true, cmd)
  for (const cmd of findVectors.readOnly) assert.equal(isFindMutation(cmd), false, cmd)
})

test("chainedFindMutation catches a mutating find hidden behind an allowed read", () => {
  assert.equal(chainedFindMutation("git status && find . -delete"), true)
  assert.equal(chainedFindMutation("find . -name '*.ts' | head"), false)
  // A quoted -delete stays a pattern, not a flag.
  assert.equal(chainedFindMutation("find . -name '-delete'"), false)
})



test("isAdoMcpWriteViolation permits only the three writes the loop may make", () => {
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_create_pull_request_thread"), false)
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_reply_to_comment"), false)
  // Creation is allowed ONLY as a draft — the rule the old name-level check
  // could not see, because draftness lives in the arguments.
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_create_pull_request", { isDraft: true }), false)
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_create_pull_request", {}), true)
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_create_pull_request", { isDraft: false }), true)
})

test("isAdoMcpWriteViolation blocks every mutator, including ones no name pattern would catch", () => {
  // These are the reason the check enumerates what is PERMITTED: the previous
  // regex allow-listed by name shape and let all of these through.
  for (const tool of [
    "repo_update_pull_request",
    "repo_vote_pull_request",
    "repo_update_pull_request_reviewers",
    "repo_update_pull_request_thread",
    "repo_create_branch",
    "pipelines_run_pipeline",
    "pipelines_update_build_stage",
    "pipelines_create_pipeline",
  ]) {
    assert.equal(isAdoMcpWriteViolation(`mcp__azure-devops__${tool}`), true, tool)
  }
})

test("isAdoMcpWriteViolation fails closed on an unknown ADO tool and ignores non-ADO servers", () => {
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_some_future_tool"), true)
  assert.equal(isAdoMcpWriteViolation("mcp__ado__pr_set_vote"), true)
  assert.equal(isAdoMcpWriteViolation("mcp__azure-devops__repo_get_pull_request_by_id"), false)
  assert.equal(isAdoMcpWriteViolation("mcp__github__merge_pull_request"), false)
  assert.equal(isAdoMcpWriteViolation("Bash"), false)
})

test("isAdoMcpToolOutOfStageScope holds a call to the stage's own manifest budget", () => {
  const granted = ["repo_get_pull_request_by_id", "repo_list_pull_request_threads"]
  assert.equal(isAdoMcpToolOutOfStageScope("mcp__azure-devops__repo_get_pull_request_by_id", granted), false)
  // A read that is legal in general but not granted to THIS stage.
  assert.equal(isAdoMcpToolOutOfStageScope("mcp__azure-devops__pipelines_get_builds", granted), true)
  // A stage that declares no ADO tools may make no ADO call at all.
  assert.equal(isAdoMcpToolOutOfStageScope("mcp__azure-devops__repo_get_pull_request_by_id", []), true)
  assert.equal(isAdoMcpToolOutOfStageScope("Bash", []), false)
})
