#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse guard hook. `npm run build:hooks`
 * (scripts/build-hooks.mjs) esbuild-bundles this file — inlining the
 * @agentic-loop/core backlog-mutation guard — into the self-contained
 * ../check-stage-guard.mjs that hooks.json actually runs (hooks execute under
 * bare `node` from a possibly-copied plugin dir with no node_modules).
 * Never edit the bundled output by hand; edit this file and rebuild.
 *
 * Three safety controls:
 *
 *  0. Backlog-mutation guard — ALWAYS ON, loop or no loop: direct Bash/Write/
 *     Edit mutations of `<tasksDir>/` are blocked (the folder a task file
 *     lives in IS its state; only the MCP verbs may move it). Carve-outs:
 *     authoring drafts (`draft/*.md`) and the live PLAN stage writing its own
 *     `queued/` task. The classifier is @agentic-loop/core/task/guard —
 *     the same code the OpenCode plugin enforces in `tool.execute.before`.
 *  1. Check-stage bash allowlist — while the loop is in VERIFY or REVIEW, Bash is
 *     restricted to a default-deny read/test allowlist (threat-model T2). The
 *     active stage is read from the marker the MCP server writes
 *     (<tasksDir>/runs/.stage.json via loop_stage/loop_advance).
 *  2. Worktree pinning — while a worktree-isolated loop is active, edit/write
 *     tools may not touch anything outside the worktree (fail closed:
 *     relative and unreadable paths are refused, and the worktree's frozen
 *     copy of the backlog is off-limits — task files are driver-owned on the
 *     main tree), and (2b) Bash is pinned too: the agent session's real cwd
 *     is the MAIN tree, so a command without the `cd <wt> && ` prefix is
 *     blocked unless it is read-only or a `git -C <wt> …`
 *     (@agentic-loop/core/loop/worktree-guard).
 *  3. Azure DevOps write backstop — ALWAYS ON: a sitter kind reaches ADO over
 *     REST (curl + PAT, `ado.access: "rest"`) or the az CLI (`"az"`) and may only
 *     read, POST a thread-comment reply, or create a brand-new DRAFT pull request
 *     (dep-sitter/main-sitter's publish — REST drafts via `isDraft: true` in the
 *     body, az via `--draft`). Any other write — PATCH/PUT/DELETE, a POST to an
 *     EXISTING PR's resource (complete/abandon/approve/reviewers/run-pipeline),
 *     or the mutating `az repos pr`/`az pipelines` verbs — is denied outright.
 *     For `ado.access: "mcp"` there is additionally a BEST-EFFORT name-pattern
 *     blocklist of mutating ADO MCP tools (gated on a live ado loop marker). The
 *     stage prompts + host-pinned allowlist are the primary control; this is
 *     defense-in-depth (threat-model T8/T12/T13).
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import fs from "node:fs"
import path from "node:path"
import { classifyMutation } from "@agentic-loop/core/task/guard"
import { classifyWorktreeBash, isUnderTasksDir } from "@agentic-loop/core/loop/worktree-guard"
import { VERIFY_ALLOW, REVIEW_ALLOW, commandAllowed, chainedAdoWriteBackstopViolation, chainedAdoAzWriteViolation, chainedGithubPrMutation, chainedGitPushViolation, isAdoMcpMutationTool } from "./allowlist.mjs"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

const allow = () => process.exit(0)
const block = (reason) => {
  process.stderr.write(reason + "\n")
  process.exit(2)
}

// Check-stage allowlist matching (built-in fallback lists + the segment-splitting
// `commandAllowed`) lives in ./allowlist.mjs so it is unit-testable and the
// chain-split rule has a single home.

// tasksDir defaults to docs/tasks; honor .agentic-loop.json if present.
const readTasksDir = (cwd) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-loop.json"), "utf8"))
    if (typeof cfg.tasksDir === "string" && cfg.tasksDir) return cfg.tasksDir
  } catch {
    /* default */
  }
  return "docs/tasks"
}

const readMarker = (cwd, tasksDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, tasksDir, "runs", ".stage.json"), "utf8"))
  } catch {
    return null
  }
}

const main = async () => {
  let input
  try {
    input = JSON.parse(await read())
  } catch {
    return allow()
  }
  const cwd = input.cwd || process.cwd()
  const tasksDir = readTasksDir(cwd)
  const marker = readMarker(cwd, tasksDir)
  const tool = input.tool_name
  const ti = input.tool_input || {}

  // (3) ADO REST write backstop — always on. Every sitter kind reaches ADO via
  // curl+PAT and may only GET, POST a thread-comment reply, or POST a brand-new
  // pull request; every mutation of an EXISTING PR is off-limits (threat-model
  // T8/T12/T13).
  if (tool === "Bash" && chainedAdoWriteBackstopViolation(String(ti.command ?? ""))) {
    return block(
      `agentic-loop: the loop must never mutate an existing pull request — this Azure DevOps REST call is blocked. ` +
        `Only GET reads, thread-comment replies (POST to a /threads resource), and creating a new draft PR ` +
        `(POST to .../pullrequests) are permitted; completing, abandoning, approving, reviewer changes, and ` +
        `pipeline runs stay a human call.`,
    )
  }

  // (3a) ADO az-CLI write backstop — always on, the az mirror of (3): the same
  // read/thread-reply/draft-PR-create envelope enforced over `az repos`/
  // `az pipelines`/`az devops invoke` commands (config `ado.access: "az"`).
  if (tool === "Bash" && chainedAdoAzWriteViolation(String(ti.command ?? ""))) {
    return block(
      `agentic-loop: the loop must never mutate an existing pull request — this az CLI call is blocked. ` +
        `Only reads, thread-comment replies (az devops invoke POST to a pullRequestThreads/pullRequestThreadComments ` +
        `resource), and creating a new DRAFT PR (az repos pr create --draft) are permitted; completing, abandoning, ` +
        `voting, reviewer changes, and pipeline runs stay a human call.`,
    )
  }

  // (0) backlog-mutation guard — always on, marker or not: raw mv/mkdir/rm or
  // Write/Edit under the backlog bypasses the MCP state machine. The classifier
  // is core's classifyMutation — the same code the OpenCode plugin runs.
  const planTaskId = marker && marker.stage === "plan" && typeof marker.taskId === "string" ? marker.taskId : null
  const filePath = ti.file_path ?? ti.path ?? ti.notebook_path
  const backlogVerdict = classifyMutation(
    String(tool ?? ""),
    {
      ...(typeof filePath === "string" ? { filePath } : {}),
      ...(typeof ti.command === "string" ? { command: ti.command } : {}),
    },
    { tasksDir, planTaskId },
  )
  if (!backlogVerdict.allow) return block(backlogVerdict.reason)

  if (!marker) return allow() // no active loop stage — nothing else to enforce

  // (3d) ADO MCP write blocklist — on whenever an ado-platform loop stage is
  // live (config `ado.access: "mcp"` sessions, but any ADO MCP tool call during
  // an ado loop counts). BEST-EFFORT: third-party MCP tool names aren't ours to
  // enumerate, so this pattern-matches conventional mutating names
  // (update/complete/merge/vote/…); the stage prompt's NEVER clause stays the
  // primary control. Creation tools pass — publish stages open draft PRs.
  if (marker.platform === "ado" && typeof tool === "string" && isAdoMcpMutationTool(tool)) {
    return block(
      `agentic-loop: the loop must never mutate an existing pull request — this Azure DevOps MCP tool looks ` +
        `state-mutating and is blocked. Only reads, thread-comment replies, and creating a new DRAFT PR are ` +
        `permitted; completing, abandoning, approving, voting, and reviewer changes stay a human call.`,
    )
  }

  // (3b) GitHub PR-mutation backstop — on whenever a loop stage is live (the
  // mirror of the ADO write backstop above). No loop stage — publish, fix, or any
  // other — may merge, close, approve, or otherwise mutate a pull request; the
  // stage allowlist permits `gh api *` for reads/replies but can't exclude the
  // mutating REST route (`gh api -X PUT …/merge`), so this catches it. Gated on the
  // marker so a human's manual `gh pr merge` outside a loop is untouched.
  if (tool === "Bash" && chainedGithubPrMutation(String(ti.command ?? ""))) {
    return block(
      `agentic-loop: the loop must never mutate a pull request — this GitHub command is blocked. ` +
        `Only reads and comment replies (gh pr comment, or gh api GET, or a POST to an issues/N/comments resource) ` +
        `are permitted; merging, closing, approving, requesting changes, reviewer changes, and edits stay a human call.`,
    )
  }

  // (3c) git-push backstop — on whenever a loop stage is live. The sitters push
  // only their own head fast-forward; a refspec (`x:main`), a force, or a delete
  // that the dotAll push allowlist glob can't exclude is blocked here. A human's
  // manual push outside a loop is untouched (gated on the marker, like 3b).
  if (tool === "Bash" && chainedGitPushViolation(String(ti.command ?? ""))) {
    return block(
      `agentic-loop: the loop must never push a branch other than its own head, force-push, or delete — this git push is blocked. ` +
        `Push only your own feature/* (or <kind>/*) branch fast-forward with no ':dst' refspec, no --force, no --delete; ` +
        `the watched and default branches stay a human call.`,
    )
  }

  // (0) stage deadline — a stage past stageTimeoutMinutes is starved of guarded
  // tools so it returns control; loop_advance then stops the loop.
  if (typeof marker.deadline === "number" && Date.now() > marker.deadline) {
    if (["Bash", "Edit", "Write", "MultiEdit"].includes(tool)) {
      return block(
        `agentic-loop: the ${String(marker.stage).toUpperCase()} stage exceeded its stageTimeoutMinutes deadline — ` +
          `stop working, summarize what you have, and return control so the loop can stop cleanly.`,
      )
    }
  }

  // (1) bash allowlist for check stages. The marker carries the loop kind's
  // manifest allowlist (loops/<kind>/loop.json); the built-in engineering
  // lists remain as a fallback for markers written by older servers.
  const markerList =
    Array.isArray(marker.bashAllowlist) && marker.bashAllowlist.every((g) => typeof g === "string") && marker.bashAllowlist.length
      ? marker.bashAllowlist
      : null
  if (tool === "Bash" && (markerList || marker.stage === "verify" || marker.stage === "review")) {
    const cmd = String(ti.command ?? "")
    const list = markerList ?? (marker.stage === "verify" ? VERIFY_ALLOW : REVIEW_ALLOW)
    if (!commandAllowed(cmd, list)) {
      return block(
        `agentic-loop: the ${marker.stage.toUpperCase()} stage is read-only — the command "${cmd}" is not on its allowlist. ` +
          `Only inspection/test commands are permitted; if a test runner is genuinely needed, record an ERROR verdict naming it. ` +
          (marker.worktree ? `Test commands must use the \`cd ${marker.worktree} && <runner>\` form.` : ""),
      )
    }
  }

  // (2b) worktree bash pin — the agent session's real cwd is the MAIN tree
  // (the engine only conveys the worktree as prompt text), so a command
  // without the `cd <wt> && ` prefix would silently run outside the isolation.
  // Runs after the check-stage allowlist so its teaching message fires first
  // for verify/review; this catches allowlisted-but-unpinned runners too
  // (a bare `npm test` in VERIFY).
  if (tool === "Bash" && marker.worktree) {
    const pinVerdict = classifyWorktreeBash(String(ti.command ?? ""), marker.worktree)
    if (!pinVerdict.allow) return block(pinVerdict.reason)
  }

  // (2) worktree pinning for edit/write tools. Fail CLOSED (same contract as
  // the OpenCode host): a relative path resolves against the session's cwd —
  // the MAIN tree — and a path we can't read is unguardable; both are refused.
  if (marker.worktree && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const fp = ti.file_path ?? ti.path ?? ti.notebook_path
    if (typeof fp !== "string") {
      return block(
        `agentic-loop: this loop is isolated to its worktree ${marker.worktree}, but ${tool}'s target path could not be determined — pass an absolute path under the worktree.`,
      )
    }
    if (!path.isAbsolute(fp)) {
      return block(
        `agentic-loop: this loop is isolated to its worktree ${marker.worktree} — "${fp}" is a relative path that resolves against the main tree. Use an absolute path under the worktree.`,
      )
    }
    const rel = path.relative(marker.worktree, path.resolve(fp))
    if (rel === "" || rel.startsWith("..")) {
      return block(`agentic-loop: this loop is isolated to its worktree ${marker.worktree} — editing ${fp} is outside it. Use a path under the worktree.`)
    }
    // The worktree carries a checkout-time frozen copy of the backlog; an edit
    // there rides the feature branch and resurrects the task file in the wrong
    // status folder on merge.
    if (isUnderTasksDir(fp, marker.worktree, tasksDir)) {
      return block(
        `agentic-loop: task files are driver-owned and live on the main tree — the loop records notes and moves itself; do not edit the worktree's frozen ${tasksDir} copy.`,
      )
    }
  }

  return allow()
}

main()
