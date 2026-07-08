#!/usr/bin/env node
/**
 * PreToolUse guard for the agentic-loop plugin. Three safety controls:
 *
 *  0. Backlog-mutation guard — ALWAYS ON, loop or no loop: direct Bash/Write/
 *     Edit mutations of `<tasksDir>/` are blocked (the folder a task file
 *     lives in IS its state; only the MCP verbs may move it). Carve-outs:
 *     authoring drafts (`draft/*.md`) and the live PLAN stage writing its own
 *     `queued/` task. Inline copy of packages/core/src/task/guard.ts — keep
 *     in sync.
 *  1. Check-stage bash allowlist — while the loop is in VERIFY or REVIEW, Bash is
 *     restricted to a default-deny read/test allowlist (threat-model T2). The
 *     active stage is read from the marker the MCP server writes
 *     (<tasksDir>/runs/.stage.json via loop_stage/loop_advance).
 *  2. Worktree pinning — while a worktree-isolated loop is active, edit/write
 *     tools may not touch absolute paths outside the worktree.
 *  3. Azure DevOps MCP write backstop — ALWAYS ON: the PR sitter's ado-mcp mode
 *     may only read PRs and reply to comments; PR-mutating MCP tools (complete/
 *     abandon/approve/reviewers/run-pipeline/create-PR) are denied outright.
 *     The agent frontmatter tools list is the primary control; this is
 *     defense-in-depth in case an agent is mis-authored (threat-model T8).
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import fs from "node:fs"
import path from "node:path"

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

// --- allowlists (ported from loop-verify.md / loop-review.md frontmatter) ---
const GIT_READ = ["git status*", "git diff*", "git log*", "git show*", "git -C * status*", "git -C * diff*", "git -C * log*", "git -C * show*"]
const READ = ["ls*", "cat *", "head *", "tail *", "grep *", "find *", "wc *"]
const RUNNERS = ["npm test*", "npm run *", "pnpm test*", "pnpm run *", "yarn test*", "yarn run *", "bun test*", "node --test*", "npx tsc*", "npx vitest*", "npx jest*", "npx eslint*", "pytest*", "go test*", "cargo test*", "make test*", "make check*"]
const CD_RUNNERS = RUNNERS.map((r) => `cd * && ${r}`)
const VERIFY_ALLOW = [...GIT_READ, ...READ, ...RUNNERS, ...CD_RUNNERS]
const REVIEW_ALLOW = [...GIT_READ, "git blame*", "git -C * blame*", ...READ]

const toRe = (glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "s")
const matchesAny = (cmd, globs) => globs.some((g) => toRe(g).test(cmd.trim()))

// Azure DevOps MCP tools that can mutate a PR — never available to the sitter
// (server named `ado` by convention; the stage prompts + agent frontmatter
// only ever call the read-only tools + repo_reply_to_comment / create-thread).
const ADO_WRITE_TOOLS = new Set([
  "mcp__ado__repo_update_pull_request", // complete / abandon / reactivate
  "mcp__ado__repo_vote_pull_request", // approve / reject
  "mcp__ado__repo_update_pull_request_reviewers",
  "mcp__ado__repo_create_pull_request",
  "mcp__ado__pipelines_run_pipeline",
])

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

// --- (0) backlog-mutation guard — inline copy of packages/core/src/task/guard.ts; keep in sync ---

const HOW_TO_MUTATE =
  "the folder a backlog file lives in IS its state — mutate it only through the loop tools " +
  "(loop_task_approve / loop_plan_approve / loop_replan / loop_ship / loop_move / loop_doctor) " +
  "or the /agent-loop-task verbs, never by hand."

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const backlogRelPath = (filePath, tasksDir) => {
  const normalized = filePath.replace(/\\/g, "/")
  const m = new RegExp(`(?:^|/)${escapeRe(tasksDir)}/(.+)$`).exec(normalized)
  return m?.[1] ?? null
}

const BACKLOG_READ_ONLY = [
  "ls*", "cat *", "head *", "tail *", "grep *", "rg *", "find *", "wc *", "diff *", "stat *", "tree*",
  "git status*", "git diff*", "git log*", "git show*", "git blame*",
  "git -C * status*", "git -C * diff*", "git -C * log*", "git -C * show*", "git -C * blame*",
]

const MUTATING_TOKENS = [" -exec", " -execdir", " -delete", " -ok "]

/** {allow:true} | {allow:false, reason}; mirrors guard.ts's classifyMutation. */
const classifyBacklogMutation = (tool, ti, tasksDir, planTaskId) => {
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const fp = ti.file_path ?? ti.path ?? ti.notebook_path
    if (typeof fp !== "string") return { allow: true }
    const rel = backlogRelPath(fp, tasksDir)
    if (rel === null) return { allow: true }
    const segments = rel.split("/")
    const isDirectMd = segments.length === 2 && segments[1].toLowerCase().endsWith(".md")
    if (isDirectMd && segments[0] === "draft") return { allow: true }
    if (isDirectMd && segments[0] === "queued" && planTaskId && segments[1] === `${planTaskId}.md`) {
      return { allow: true }
    }
    return {
      allow: false,
      reason:
        `agentic-loop: direct edits under ${tasksDir}/ are limited to draft/*.md ` +
        `(and the live PLAN stage's own queued/ task) — ${HOW_TO_MUTATE}`,
    }
  }
  if (tool === "Bash") {
    const cmd = String(ti.command ?? "")
    if (!cmd.includes(tasksDir)) return { allow: true }
    if (/>/.test(cmd)) {
      return { allow: false, reason: `agentic-loop: redirecting output while referencing ${tasksDir}/ is blocked — ${HOW_TO_MUTATE}` }
    }
    if (MUTATING_TOKENS.some((t) => cmd.includes(t))) {
      return { allow: false, reason: `agentic-loop: this command can mutate ${tasksDir}/ — ${HOW_TO_MUTATE}` }
    }
    // Split on newlines too (mirrors guard.ts): a bare `\n` chains commands like `;`,
    // and the read-only globs are dotAll, so a read-only first line must not swallow a
    // following mutation across the newline. Each non-empty segment must match on its own.
    const segments = cmd
      .split(/&&|\|\||;|\||\n|\r/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (segments.every((s) => matchesAny(s, BACKLOG_READ_ONLY))) return { allow: true }
    return {
      allow: false,
      reason:
        `agentic-loop: only read-only commands (ls/cat/head/tail/grep/rg/find/wc/diff/stat/tree, git reads) ` +
        `may reference ${tasksDir}/ — ${HOW_TO_MUTATE}`,
    }
  }
  return { allow: true }
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

  // (3) ADO MCP write backstop — always on. The sitter only reads PRs and posts
  // thread replies; every PR-mutating ADO MCP tool is off-limits (threat-model T8).
  if (ADO_WRITE_TOOLS.has(tool)) {
    return block(
      `agentic-loop: the PR sitter must never mutate a pull request — "${tool}" is blocked. ` +
        `Only read-only ADO MCP tools and repo_reply_to_comment / repo_create_pull_request_thread are permitted; ` +
        `merging, completing, abandoning, approving, and reviewer changes stay a human call.`,
    )
  }

  // (0) backlog-mutation guard — always on, marker or not: raw mv/mkdir/rm or
  // Write/Edit under the backlog bypasses the MCP state machine.
  const planTaskId = marker && marker.stage === "plan" && typeof marker.taskId === "string" ? marker.taskId : null
  const backlogVerdict = classifyBacklogMutation(tool, ti, tasksDir, planTaskId)
  if (!backlogVerdict.allow) return block(backlogVerdict.reason)

  if (!marker) return allow() // no active loop stage — nothing else to enforce

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
    if (!matchesAny(cmd, list)) {
      return block(
        `agentic-loop: the ${marker.stage.toUpperCase()} stage is read-only — the command "${cmd}" is not on its allowlist. ` +
          `Only inspection/test commands are permitted; if a test runner is genuinely needed, record an ERROR verdict naming it. ` +
          (marker.worktree ? `Test commands must use the \`cd ${marker.worktree} && <runner>\` form.` : ""),
      )
    }
  }

  // (2) worktree pinning for edit/write tools
  if (marker.worktree && ["Edit", "Write", "MultiEdit"].includes(tool)) {
    const fp = ti.file_path ?? ti.path
    if (typeof fp === "string" && path.isAbsolute(fp)) {
      const rel = path.relative(marker.worktree, path.resolve(fp))
      if (rel === "" || rel.startsWith("..")) {
        return block(`agentic-loop: this loop is isolated to its worktree ${marker.worktree} — editing ${fp} is outside it. Use a path under the worktree.`)
      }
    }
  }

  return allow()
}

main()
