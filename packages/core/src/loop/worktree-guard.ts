import path from "node:path"
import type { GuardVerdict } from "../task/guard.js"
import { splitSegments } from "../task/write-backstop.js"

/**
 * Worktree bash pin: classifies a shell command a worktree-isolated stage agent
 * is about to run. The engine only ever CONVEYS the worktree as prompt text
 * ("prefix every shell command with `cd <wt> && `") — neither host can set the
 * agent session's real cwd — so a command that forgets the prefix silently runs
 * in the main tree. Both hosts enforce this classifier the same way they
 * enforce the edit-tool worktree pin: OpenCode in `tool.execute.before`, the
 * Claude Code PreToolUse hook via the esbuild-bundled entry.
 *
 * Like `task/guard.ts` this is heuristic defense-in-depth against
 * degraded/confused models, not a sandbox: subshells (`$()`, backticks),
 * env-var-assembled paths, and absolute main-tree paths inside a pinned
 * segment remain residuals. Pure.
 */

const ALLOW: GuardVerdict = { allow: true }
const block = (reason: string): GuardVerdict => ({ allow: false, reason })

// Read-only inspection commands that may run unpinned (they resolve against the
// main tree, but cannot mutate it). Same glob vocabulary as task/guard.ts and
// the check-stage allowlists.
const READ_ONLY = [
  "ls*",
  "pwd*",
  "cat *",
  "head *",
  "tail *",
  "grep *",
  "rg *",
  "find *",
  "wc *",
  "stat *",
  "tree*",
  "diff *",
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git blame*",
  "git -C * status*",
  "git -C * diff*",
  "git -C * log*",
  "git -C * show*",
  "git -C * blame*",
]

// Tokens that turn a read-only shape into a mutation (find -exec/-delete), plus
// `>` redirection — splitSegments does not split on `>`, and an unpinned
// redirect writes a file relative to the session cwd: the main tree.
const MUTATING_TOKENS = [" -exec", " -execdir", " -delete", " -ok "]

const toRe = (glob: string): RegExp =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "s")

const matchesAny = (cmd: string, globs: readonly string[]): boolean => globs.some((g) => toRe(g).test(cmd.trim()))

const isReadOnlySegment = (segment: string): boolean =>
  matchesAny(segment, READ_ONLY) && !/>/.test(segment) && !MUTATING_TOKENS.some((t) => segment.includes(t))

/** Strip one layer of surrounding single/double quotes from a shell word. */
const unquote = (word: string): string => {
  const m = /^(['"])(.*)\1$/.exec(word)
  return m ? m[2]! : word
}

/** Whether `target` (absolute) is the worktree root or inside it. */
const underWorktree = (worktree: string, target: string): boolean => {
  const rel = path.relative(worktree, target)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** The `git -C <dir>` target of a segment, or null when it isn't that shape. */
const gitCDir = (segment: string): string | null => {
  const m = /^git\s+-C\s+(\S+)\s+/.exec(segment.trim())
  return m ? unquote(m[1]!) : null
}

/**
 * Classify one bash command against a live worktree pin. Verdict rules, walked
 * per chain/pipe segment (quote-aware split, shared with the write backstops):
 *
 *  - `cd <absolute path under worktree>` pins the rest of the chain; a relative
 *    `cd` while pinned re-resolves against the pinned directory and stays
 *    allowed while it cannot escape the worktree; any other `cd` — relative
 *    while unpinned, or absolute outside — is blocked.
 *  - A pinned segment is allowed (it executes inside the worktree).
 *  - An unpinned segment is allowed only when it is `git -C <dir-under-wt> …`
 *    (any git op — the tree it acts on is the worktree's) or a read-only
 *    inspection command (reads of the main tree cannot corrupt it). Everything
 *    else is blocked with the `cd <wt> && ` teaching message.
 */
export const classifyWorktreeBash = (command: string, worktree: string): GuardVerdict => {
  let pinnedDir: string | null = null
  for (const segment of splitSegments(command)) {
    // `.+` not `\S+`: real worktree paths can contain spaces (quoted), e.g. under "Claude Code/".
    const cdMatch = /^cd\s+(.+)$/.exec(segment)
    if (cdMatch) {
      const target = unquote(cdMatch[1]!)
      const resolved: string | null = path.isAbsolute(target)
        ? path.resolve(target)
        : pinnedDir
          ? path.resolve(pinnedDir, target)
          : null
      if (resolved && underWorktree(worktree, resolved)) {
        pinnedDir = resolved
        continue
      }
      return block(
        `agentic-loop: this loop is isolated to its worktree ${worktree} — "${segment}" leaves it, so the rest of ` +
          `the command would run outside the worktree. Only \`cd\` into a directory under ${worktree}.`,
      )
    }
    if (pinnedDir) continue
    const gitDir = gitCDir(segment)
    if (gitDir && path.isAbsolute(gitDir) && underWorktree(worktree, path.resolve(gitDir))) continue
    if (isReadOnlySegment(segment)) continue
    return block(
      `agentic-loop: this loop is isolated to its worktree ${worktree} — "${segment}" would run in the main tree. ` +
        `Prefix the command with \`cd ${worktree} && \` (or use \`git -C ${worktree} …\`).`,
    )
  }
  return ALLOW
}

/**
 * Whether `filePath` points into the worktree's own copy of the backlog
 * (`<worktree>/<tasksDir>/…`). Task files are driver-owned and live on the
 * MAIN tree — the worktree carries a frozen checkout-time copy that must never
 * be edited (a change there rides the feature branch and resurrects the task
 * file in the wrong status folder on merge). Pure.
 */
export const isUnderTasksDir = (filePath: string, worktree: string, tasksDir: string): boolean => {
  const tasksRoot = path.resolve(worktree, tasksDir)
  const rel = path.relative(tasksRoot, path.resolve(filePath))
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}
