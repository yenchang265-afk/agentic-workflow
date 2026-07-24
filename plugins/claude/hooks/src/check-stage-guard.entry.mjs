#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse guard hook. `npm run build:hooks`
 * (scripts/build-hooks.mjs) esbuild-bundles this file — inlining the
 * @agentic-workflow/core backlog-mutation guard — into the self-contained
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
 *     `queued/` task. The classifier is @agentic-workflow/core/task/guard —
 *     the same code the OpenCode plugin enforces in `tool.execute.before`.
 *  1. Check-stage bash allowlist — while the loop is in VERIFY or REVIEW, Bash is
 *     restricted to a default-deny read/test allowlist (threat-model T2). The
 *     active stage is read from the marker the MCP server writes
 *     (<tasksDir>/runs/.stage.json via workflow_stage/workflow_advance).
 *  2. Worktree pinning — while a worktree-isolated loop is active, edit/write
 *     tools may not touch anything outside the worktree (fail closed:
 *     relative and unreadable paths are refused, and the worktree's frozen
 *     copy of the backlog is off-limits — task files are driver-owned on the
 *     main tree), and (2b) Bash is pinned too: the agent session's real cwd
 *     is the MAIN tree, so a command without the `cd <wt> && ` prefix is
 *     blocked unless it is read-only or a `git -C <wt> …`
 *     (@agentic-workflow/core/workflow/worktree-guard).
 *  3. Azure DevOps write backstop — ALWAYS ON: a sitter kind reaches ADO
 *     through the az CLI and may only read, POST a thread-comment reply, or
 *     create a brand-new DRAFT pull request (dep-sitter/main-sitter's publish —
 *     `az repos pr create --draft`). Any other write — the mutating
 *     `az repos pr`/`az pipelines` verbs, or an `az devops invoke` that isn't a
 *     GET / thread-reply / PR-create POST — is denied outright. Two extra rails
 *     cover paths the az allowlist can't: a mutating `curl` to dev.azure.com is
 *     blocked (the az allowlist already refuses curl, but a chained command
 *     could smuggle one), and — gated on a live ado loop marker — a BEST-EFFORT
 *     name-pattern blocklist of mutating tools on any Azure DevOps MCP server
 *     the user has connected. The stage prompts + host-pinned allowlist are the
 *     primary control; these are defense-in-depth (threat-model T8/T12/T13).
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import fs from "node:fs"
import path from "node:path"
import { classifyMutation } from "@agentic-workflow/core/task/guard"
import { pinBash, pinEditPath } from "@agentic-workflow/core/workflow/worktree-guard"
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

/**
 * Let the call proceed with CORRECTED input. `updatedInput` replaces
 * `tool_input` before the tool executes, so the worktree pin can fix a missing
 * `cd <wt> && ` prefix or a main-tree file path instead of refusing and making
 * the agent guess again — the retry loop was the isolation's worst failure mode.
 *
 * Deliberately NO `permissionDecision`: this hook's job is to correct the input,
 * not to grant permission. Emitting `"allow"` would auto-approve every rewritten
 * command, so a command the user would normally be prompted about would run
 * unprompted purely because the pin touched it — strictly more privilege than
 * the block-only guard it replaces. Omitting the field leaves the normal
 * permission flow to rule on the corrected input.
 */
const rewriteInput = (updatedInput) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }) + "\n")
  process.exit(0)
}

// Check-stage allowlist matching (built-in fallback lists + the segment-splitting
// `commandAllowed`) lives in ./allowlist.mjs so it is unit-testable and the
// chain-split rule has a single home.

// Every built-in file-writing tool, in one place so the pin and the stage
// deadline agree on what counts as a write. `MultiEdit` is deliberately absent:
// no such tool exists, so matching it only obscured that `NotebookEdit` is the
// third real one.
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"]

// tasksDir defaults to docs/tasks; honor .agentic-workflow.json if present.
const readTasksDir = (cwd) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-workflow.json"), "utf8"))
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
      `agentic-workflow: the loop must never mutate an existing pull request — this Azure DevOps REST call is blocked. ` +
        `Only GET reads, thread-comment replies (POST to a /threads resource), and creating a new draft PR ` +
        `(POST to .../pullrequests) are permitted; completing, abandoning, approving, reviewer changes, and ` +
        `pipeline runs stay a human call.`,
    )
  }

  // (3a) ADO az-CLI write backstop — always on, the az mirror of (3): the same
  // read/thread-reply/draft-PR-create envelope enforced over `az repos`/
  // `az pipelines`/`az devops invoke` commands (the only way the loop reaches ADO).
  if (tool === "Bash" && chainedAdoAzWriteViolation(String(ti.command ?? ""))) {
    return block(
      `agentic-workflow: the loop must never mutate an existing pull request — this az CLI call is blocked. ` +
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
  // live. The loop drives ADO through the az CLI, not an MCP server, but a user
  // may have an Azure DevOps MCP server connected for their own use; this keeps
  // a stage agent from reaching through it to vote/complete/merge. BEST-EFFORT:
  // third-party MCP tool names aren't ours to enumerate, so this pattern-matches
  // conventional mutating names (update/complete/merge/vote/…); the stage
  // prompt's NEVER clause stays the primary control. Creation tools pass —
  // publish stages open draft PRs.
  if (marker.platform === "ado" && typeof tool === "string" && isAdoMcpMutationTool(tool)) {
    return block(
      `agentic-workflow: the loop must never mutate an existing pull request — this Azure DevOps MCP tool looks ` +
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
      `agentic-workflow: the loop must never mutate a pull request — this GitHub command is blocked. ` +
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
      `agentic-workflow: the loop must never push a branch other than its own head, force-push, or delete — this git push is blocked. ` +
        `Push only your own feature/* (or <kind>/*) branch fast-forward with no ':dst' refspec, no --force, no --delete; ` +
        `the watched and default branches stay a human call.`,
    )
  }

  // (0) stage deadline — a stage past stageTimeoutMinutes is starved of guarded
  // tools so it returns control; workflow_advance then stops the loop.
  if (typeof marker.deadline === "number" && Date.now() > marker.deadline) {
    if (tool === "Bash" || WRITE_TOOLS.includes(tool)) {
      return block(
        `agentic-workflow: the ${String(marker.stage).toUpperCase()} stage exceeded its stageTimeoutMinutes deadline — ` +
          `stop working, summarize what you have, and return control so the loop can stop cleanly.`,
      )
    }
  }

  // (2b) worktree bash pin — the agent session's real cwd is the MAIN tree (the
  // engine only conveys the worktree as prompt text), so a command without the
  // `cd <wt> && ` prefix would silently run outside the isolation. The pin
  // CORRECTS that by prefixing rather than refusing; only a command that
  // explicitly leaves the worktree blocks.
  //
  // Runs BEFORE the check-stage allowlist so the allowlist sees the command that
  // will actually execute — the manifest lists the compound `cd * && <runner>`
  // form, so a bare `npm test` in VERIFY passes only once it has been pinned.
  const stageWorktree = typeof marker.worktree === "string" && marker.worktree ? marker.worktree : null
  // The worktree the LOOP owns, regardless of whether THIS stage is isolated
  // (engineering plan is `isolation: "none"`). Without it every write during an
  // unisolated stage — bash included — was unguarded and landed on the human's
  // branch.
  const workflowWorktree = stageWorktree ?? (typeof marker.workflowWorktree === "string" && marker.workflowWorktree ? marker.workflowWorktree : null)

  const rawCommand = String(ti.command ?? "")
  let effectiveCommand = rawCommand
  let commandRewritten = false
  if (tool === "Bash" && workflowWorktree) {
    const pinVerdict = pinBash(rawCommand, workflowWorktree)
    if (pinVerdict.action === "block") return block(pinVerdict.reason)
    if (pinVerdict.action === "rewrite") {
      // An unisolated stage has no worktree to correct INTO: prefixing would
      // move its command into a checkout it is not working in. It only needed
      // the pin to prove it was harmless, so a rewrite here means "this would
      // have mutated the main tree" — refuse it, matching the edit path below.
      if (!stageWorktree) {
        return block(
          `agentic-workflow: the ${String(marker.stage).toUpperCase()} stage does not build — "${rawCommand}" would mutate the main tree. ` +
            `Only read-only commands are available here; code changes belong to the BUILD stage, inside ${workflowWorktree}.`,
        )
      }
      effectiveCommand = pinVerdict.value
      commandRewritten = true
    }
  }

  // (1) bash allowlist for check stages. The marker carries the workflow kind's
  // manifest allowlist (workflows/<kind>/workflow.json); the built-in engineering
  // lists remain as a fallback for markers written by older servers.
  const markerList =
    Array.isArray(marker.bashAllowlist) && marker.bashAllowlist.every((g) => typeof g === "string") && marker.bashAllowlist.length
      ? marker.bashAllowlist
      : null
  if (tool === "Bash" && (markerList || marker.stage === "verify" || marker.stage === "review")) {
    const list = markerList ?? (marker.stage === "verify" ? VERIFY_ALLOW : REVIEW_ALLOW)
    if (!commandAllowed(effectiveCommand, list)) {
      return block(
        `agentic-workflow: the ${marker.stage.toUpperCase()} stage is read-only — the command "${rawCommand}" is not on its allowlist. ` +
          `Only inspection/test commands are permitted; if a test runner is genuinely needed, record an ERROR verdict naming it.`,
      )
    }
  }
  if (commandRewritten) return rewriteInput({ ...ti, command: effectiveCommand })

  // (2) worktree pinning for file-writing tools. A relative path resolves
  // against the session's cwd — the MAIN tree — and a main-tree absolute path is
  // the "agent keeps editing the current branch" symptom; both are mechanical
  // misses, so both are remapped onto the worktree. A path we cannot read at all
  // stays fail-closed, and so does one under neither tree.
  if (workflowWorktree && WRITE_TOOLS.includes(tool)) {
    const fp = ti.file_path ?? ti.path ?? ti.notebook_path
    if (typeof fp !== "string") {
      return block(
        `agentic-workflow: this loop is isolated to its worktree ${workflowWorktree}, but ${tool}'s target path could not be determined — pass an absolute path under the worktree.`,
      )
    }
    const verdict = pinEditPath(fp, workflowWorktree, cwd, tasksDir)
    if (verdict.action === "block") return block(verdict.reason)
    if (verdict.action === "rewrite") {
      // An unisolated stage has no worktree to correct INTO: PLAN does not build,
      // so a code write is a mistake to refuse, not a path to relocate onto the
      // build branch. (Its legitimate backlog write returns `allow` above.)
      if (!stageWorktree) {
        return block(
          `agentic-workflow: the ${String(marker.stage).toUpperCase()} stage does not build — it must not write ${fp}. ` +
            `Code changes belong to the BUILD stage, inside the loop's worktree ${workflowWorktree}.`,
        )
      }
      const key = ti.file_path !== undefined ? "file_path" : ti.path !== undefined ? "path" : "notebook_path"
      return rewriteInput({ ...ti, [key]: verdict.value })
    }
  }

  return allow()
}

main()
