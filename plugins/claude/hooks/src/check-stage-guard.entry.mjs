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
 *     tools may not touch absolute paths outside the worktree.
 *  3. Azure DevOps write backstop — ALWAYS ON: the PR sitter reaches ADO over
 *     its REST API (curl + PAT) and may only GET (read) or POST a thread-comment
 *     reply. Any other write — PATCH/PUT/DELETE, or a POST outside a `/threads`
 *     resource (complete/abandon/approve/reviewers/run-pipeline/create-PR) — is
 *     denied outright. The stage prompts + host-pinned allowlist are the primary
 *     control; this is defense-in-depth (threat-model T8).
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import fs from "node:fs"
import path from "node:path"
import { classifyMutation } from "@agentic-loop/core/task/guard"

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

// A Bash command that calls the Azure DevOps REST API (curl against an ADO host).
const isAdoCurl = (cmd) =>
  /\bcurl\b/.test(cmd) && /https?:\/\/(?:dev\.azure\.com|[a-z0-9.-]+\.visualstudio\.com)\//i.test(cmd)

// The effective HTTP method of a curl: an explicit -X/--request wins, else a body
// flag (-d/--data*/-F/--form) implies POST, else GET.
const curlMethod = (cmd) => {
  const explicit = /(?:-X|--request)[ =]+([A-Za-z]+)/.exec(cmd)
  if (explicit) return explicit[1].toUpperCase()
  return /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd) ? "POST" : "GET"
}

// The sitter may only read (GET) or append a thread-comment reply (POST to a
// `/threads` resource). Anything else against ADO mutates the PR — deny it.
const isAdoWriteBackstopViolation = (cmd) => {
  if (!isAdoCurl(cmd)) return false
  const method = curlMethod(cmd)
  const targetsThread = /\/threads(?:\/|\?|\b)/i.test(cmd)
  return !(method === "GET" || (method === "POST" && targetsThread))
}

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

  // (3) ADO REST write backstop — always on. The sitter reaches ADO via curl+PAT
  // and may only GET or POST a thread-comment reply; every PR-mutating call is
  // off-limits (threat-model T8).
  if (tool === "Bash" && isAdoWriteBackstopViolation(String(ti.command ?? ""))) {
    return block(
      `agentic-loop: the PR sitter must never mutate a pull request — this Azure DevOps REST call is blocked. ` +
        `Only GET reads and thread-comment replies (POST to a /threads resource) are permitted; ` +
        `merging, completing, abandoning, approving, reviewer changes, and pipeline runs stay a human call.`,
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
