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
 *     (<tasksDir>/runs/<host marker> via workflow_stage/workflow_advance).
 *  2. Worktree pinning — while a worktree-isolated loop is active, edit/write
 *     tools may not touch anything outside the worktree (fail closed:
 *     relative and unreadable paths are refused, and the worktree's frozen
 *     copy of the backlog is off-limits — task files are driver-owned on the
 *     main tree), and (2b) Bash is pinned too: the agent session's real cwd
 *     is the MAIN tree, so a command without the `cd <wt> && ` prefix is
 *     blocked unless it is read-only or a `git -C <wt> …`
 *     (@agentic-workflow/core/workflow/worktree-guard).
 *  3. Azure DevOps write backstop — ALWAYS ON: a sitter kind reaches ADO over
 *     its REST API (curl + PAT) and may only read, POST a thread-comment reply,
 *     or create a brand-new DRAFT pull request (dep-sitter/main-sitter's
 *     publish — drafts via `isDraft: true` in the body). Any other write —
 *     PATCH/PUT/DELETE, or a POST to an EXISTING PR's resource
 *     (complete/abandon/approve/reviewers/run-pipeline) — is denied outright.
 *     Two extra rails cover paths the loop itself never takes but a user
 *     environment might expose: the mutating `az repos pr`/`az pipelines` verbs
 *     are denied (in case an az CLI is on PATH and slips into a command), and —
 *     gated on a live ado loop marker — a BEST-EFFORT name-pattern blocklist of
 *     mutating tools on any Azure DevOps MCP server the user has connected. The
 *     stage prompts + host-pinned allowlist are the primary control; these are
 *     defense-in-depth (threat-model T8/T12/T13).
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import { classifyMutation } from "@agentic-workflow/core/task/guard"
import { pinBash, pinEditPath } from "@agentic-workflow/core/workflow/worktree-guard"
import {
  canonicalTool,
  dialectFor,
  hostFor,
  isBashTool,
  isWriteTool,
  unknownHostMessage,
  writePathKeyOf,
  writePathOf,
} from "./dialect.mjs"
import { VERIFY_ALLOW, REVIEW_ALLOW, commandAllowed, chainedGithubPrMutation, chainedGitPushViolation, isAdoMcpTool, isAdoMcpToolOutOfStageScope, isAdoMcpWriteViolation } from "./allowlist.mjs"
import { allow, block, readStdin as read, rewriteInput } from "./pretooluse.mjs"
import { backlogRoot, markerWriterAlive, readMarker, readTasksDir, runsDir } from "./marker.mjs"
import { evidenceEntry, noteEvidence } from "./evidence.mjs"

// The PreToolUse envelope (allow / block / rewriteInput) lives in
// ./pretooluse.mjs so this guard and the spawn-model stamp emit byte-identical
// JSON — in particular, neither ever emits `permissionDecision`.

// Check-stage allowlist matching (built-in fallback lists + the segment-splitting
// `commandAllowed`) lives in ./allowlist.mjs so it is unit-testable and the
// chain-split rule has a single home.

// Which tool names count as "the shell" and "a write" is host-specific and
// lives in ./dialect.mjs, so the pin, the stage deadline, and the backlog guard
// all agree on one answer per host.

// Reading tasksDir + the stage marker lives in ./marker.mjs, shared with the
// spawn-model stamp, the verdict guard and the reconciler — and it resolves the
// backlog exactly as the MCP SERVER does when it WRITES the marker (env root,
// repo layer over user layer). Reading only <cwd>/.agentic-workflow.json made a
// live stage look like no stage at all wherever the two disagreed.

const main = async () => {
  let input
  try {
    input = JSON.parse(await read())
  } catch {
    return allow()
  }
  const cwd = input.cwd || process.cwd()
  const host = hostFor()
  // Fail CLOSED on an unrecognized host: guessing a dialect would leave every
  // tool name unmatched and silently disarm the whole guard.
  if (host === null) return block(unknownHostMessage(process.env.AGENTIC_WORKFLOW_HOST))
  const d = dialectFor(host)
  const tasksDir = readTasksDir(backlogRoot(cwd))
  const marker = readMarker(cwd, d.stageMarkerFile)
  const tool = input.tool_name
  const ti = input.tool_input || {}
  const isBash = isBashTool(d, tool)
  const isWrite = isWriteTool(d, tool)

  // (0) backlog-mutation guard — always on, marker or not: raw mv/mkdir/rm or
  // Write/Edit under the backlog bypasses the MCP state machine. The classifier
  // is core's classifyMutation — the same code the OpenCode plugin runs.
  const planTaskId = marker && marker.stage === "plan" && typeof marker.taskId === "string" ? marker.taskId : null
  const filePath = writePathOf(ti)
  const backlogVerdict = classifyMutation(
    canonicalTool(d, tool),
    {
      ...(typeof filePath === "string" ? { filePath } : {}),
      ...(typeof ti.command === "string" ? { command: ti.command } : {}),
    },
    { tasksDir, planTaskId },
  )
  if (!backlogVerdict.allow) return block(backlogVerdict.reason)

  if (!marker) return allow() // no active loop stage — nothing else to enforce

  // (3) ADO MCP guard — on whenever an ado-platform loop stage is live. Azure
  // DevOps is reached ONLY through the MCP server now, so this is the primary
  // control rather than a best-effort backstop behind a curl allowlist.
  //
  // Two checks, both fail-closed. The write check enumerates the three writes
  // the loop may make (and requires `isDraft` on PR creation); the scope check
  // holds the call to the tools THIS stage's manifest granted, which is the
  // per-stage precision that used to be deferred as future work.
  if (marker.platform === "ado" && typeof tool === "string" && isAdoMcpTool(tool)) {
    const args = ti && typeof ti === "object" ? ti : {}
    if (isAdoMcpWriteViolation(tool, args)) {
      return block(
        `agentic-workflow: the loop must never mutate an existing pull request — this Azure DevOps MCP tool is ` +
          `blocked. Only reads, thread comments/replies, and creating a DRAFT pull request (isDraft: true) are ` +
          `permitted; completing, abandoning, approving, voting, reviewer changes, branch creation, and pipeline ` +
          `runs stay a human call.`,
      )
    }
    if (isAdoMcpToolOutOfStageScope(tool, marker.adoTools)) {
      return block(
        `agentic-workflow: the ${marker.stage ?? "current"} stage may not call this Azure DevOps MCP tool — its ` +
          `manifest grants ${(marker.adoTools ?? []).length ? (marker.adoTools ?? []).join(", ") : "no ADO tools"}. ` +
          `Add it to platformTools in workflows/<kind>/workflow.json if the stage genuinely needs it.`,
      )
    }
  }

  // The configured `bashAllowlistPrefix` values, stamped on the marker because a
  // bundled hook can read neither the config nor a manifest. Every classifier
  // below anchors on the bare tool name, so without stripping these a rewriting
  // proxy walks a mutation straight past them (`rtk gh pr merge 3`). Anything but
  // an array of strings reads as none — fail-open to the previous behaviour, the
  // same direction every other marker input here takes.
  const markerPrefixes = Array.isArray(marker.bashPrefix) && marker.bashPrefix.every((p) => typeof p === "string") ? marker.bashPrefix : []

  // (3b) GitHub PR-mutation backstop — on whenever a loop stage is live (the
  // mirror of the ADO write backstop above). No loop stage — publish, fix, or any
  // other — may merge, close, approve, or otherwise mutate a pull request; the
  // stage allowlist permits `gh api *` for reads/replies but can't exclude the
  // mutating REST route (`gh api -X PUT …/merge`), so this catches it. Gated on the
  // marker so a human's manual `gh pr merge` outside a loop is untouched.
  if (isBash && chainedGithubPrMutation(String(ti.command ?? ""), markerPrefixes)) {
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
  if (isBash && chainedGitPushViolation(String(ti.command ?? ""), markerPrefixes)) {
    return block(
      `agentic-workflow: the loop must never push a branch other than its own head, force-push, or delete — this git push is blocked. ` +
        `Push only your own feature/* (or <kind>/*) branch fast-forward with no ':dst' refspec, no --force, no --delete; ` +
        `the watched and default branches stay a human call.`,
    )
  }

  // (0) stage deadline — a stage past stageTimeoutMinutes is starved of guarded
  // tools so it returns control; workflow_advance then stops the loop. Gated on
  // the marker's WRITER still being alive: nothing removes the marker file when
  // the MCP server dies mid-stage (SIGKILL, OOM, laptop sleep), and blocking
  // unconditionally ruled the repo forever — every future session's Bash and
  // writes denied behind a loop nobody could see, with `rm` on the marker the
  // only way out. A dead or unknowable writer is a crashed run's leftover — the
  // same reading spawn-guard gives an expired marker — so fall through (fail
  // open, like every other uncertainty in these hooks).
  if (typeof marker.deadline === "number" && Date.now() > marker.deadline && markerWriterAlive(marker.pid)) {
    if (isBash || isWrite) {
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
  // will actually execute. The manifests declare BARE forms only (a hand-written
  // `cd * && ` prefix there fails scripts/workflow-allowlist.test.mjs); the
  // compound twins exist solely in OpenCode's generated frontmatter, whose
  // matcher tests the whole string. This host instead splits on `&&` and matches
  // each segment, accepting a bare `cd` as its own — so a pinned `cd <wt> && npm
  // test` and an unpinned `npm test` both match the same bare `npm test*` glob.
  const stageWorktree = typeof marker.worktree === "string" && marker.worktree ? marker.worktree : null
  // The worktree the LOOP owns, regardless of whether THIS stage is isolated
  // (engineering plan is `isolation: "none"`). Without it every write during an
  // unisolated stage — bash included — was unguarded and landed on the human's
  // branch.
  const workflowWorktree = stageWorktree ?? (typeof marker.workflowWorktree === "string" && marker.workflowWorktree ? marker.workflowWorktree : null)

  const rawCommand = String(ti.command ?? "")
  let effectiveCommand = rawCommand
  let commandRewritten = false
  if (isBash && workflowWorktree) {
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
  if (isBash && (markerList || marker.stage === "verify" || marker.stage === "review")) {
    const list = markerList ?? (marker.stage === "verify" ? VERIFY_ALLOW : REVIEW_ALLOW)
    if (!commandAllowed(effectiveCommand, list, markerPrefixes)) {
      return block(
        `agentic-workflow: the ${marker.stage.toUpperCase()} stage is read-only — the command "${rawCommand}" is not on its allowlist. ` +
          `Only inspection/test commands are permitted; if a test runner is genuinely needed, record an ERROR verdict naming it.`,
      )
    }
  }
  // (4) proof-of-work ledger for check stages. Recorded HERE — after every block
  // above, before the first allowing return — so the ledger holds what the stage
  // will actually run, never a command the allowlist refused. `workflow_verdict`
  // reads it back and rejects a PASS the stage did no work for
  // (@agentic-workflow/core/workflow/evidence). Best-effort: never blocks.
  if (marker.check === true) {
    noteEvidence(runsDir(cwd), d.evidenceFile, String(marker.stage ?? ""), evidenceEntry(d, tool, ti, effectiveCommand))
  }

  if (commandRewritten) return rewriteInput({ ...ti, command: effectiveCommand })

  // (2) worktree pinning for file-writing tools. A relative path resolves
  // against the session's cwd — the MAIN tree — and a main-tree absolute path is
  // the "agent keeps editing the current branch" symptom; both are mechanical
  // misses, so both are remapped onto the worktree. A path we cannot read at all
  // stays fail-closed, and so does one under neither tree.
  if (workflowWorktree && isWrite) {
    const fp = writePathOf(ti)
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
      const key = writePathKeyOf(ti)
      return rewriteInput({ ...ti, [key]: verdict.value })
    }
  }

  return allow()
}

main()
