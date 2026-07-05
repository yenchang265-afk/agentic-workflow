#!/usr/bin/env node
/**
 * PreToolUse guard for the agentic-loop plugin. Two safety controls the OpenCode
 * plugin enforced in-process, re-homed to a Claude Code hook:
 *
 *  1. Check-stage bash allowlist — while the loop is in VERIFY or REVIEW, Bash is
 *     restricted to a default-deny read/test allowlist (threat-model T2). The
 *     active stage is read from the marker the MCP server writes
 *     (<tasksDir>/runs/.stage.json via loop_stage/loop_advance).
 *  2. Worktree pinning — while a worktree-isolated loop is active, edit/write
 *     tools may not touch absolute paths outside the worktree.
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

const readMarker = (cwd) => {
  // tasksDir defaults to docs/tasks; honor .agentic-loop.json if present.
  let tasksDir = "docs/tasks"
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-loop.json"), "utf8"))
    if (typeof cfg.tasksDir === "string" && cfg.tasksDir) tasksDir = cfg.tasksDir
  } catch {
    /* default */
  }
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
  const marker = readMarker(cwd)
  if (!marker) return allow() // no active loop stage — nothing to enforce
  const tool = input.tool_name
  const ti = input.tool_input || {}

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
