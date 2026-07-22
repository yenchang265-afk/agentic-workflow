import path from "node:path"
import type { GuardVerdict } from "../task/guard.js"
import { splitSegments } from "../task/write-backstop.js"

/**
 * Worktree pin: keeps a worktree-isolated stage agent's shell commands and file
 * edits inside its worktree. The engine only ever CONVEYS the worktree as prompt
 * text ("prefix every shell command with `cd <wt> && `") — neither host can set
 * the agent session's real cwd — so a command that forgets the prefix silently
 * runs in the main tree. Both hosts enforce this the same way: OpenCode in
 * `tool.execute.before`, the Claude Code PreToolUse hook via the esbuild-bundled
 * entry.
 *
 * The pin CORRECTS rather than refuses. `pinBash` / `pinEditPath` return a
 * three-way verdict: an unpinned-but-harmless command is rewritten with the
 * `cd <wt> && ` prefix and a main-tree-relative or main-tree-absolute edit path
 * is remapped to its worktree mirror, so the agent never sees an error and never
 * burns an iteration rediscovering the prefix. Only a call that EXPLICITLY
 * leaves the worktree — a `cd` outside it, a `git -C <outside>` that mutates, a
 * write redirected to an absolute path outside it — is blocked outright, because
 * there is no honest way to guess what was meant.
 *
 * Like `task/guard.ts` this is heuristic defense-in-depth against
 * degraded/confused models, not a sandbox. Known residuals: subshells (`$()`,
 * backticks) and env-var-assembled paths are not resolved; a path embedded in an
 * interpreter's own source (`node -e "…writeFileSync('/repo/x')"`, `python -c`)
 * is not a shell word and so is not seen; and `path.resolve` does not follow
 * symlinks, so a symlink created inside the worktree points outward while every
 * path under it still reads as in-bounds. Pure.
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

/** Quote a path for the shell when it needs it — worktree roots live under paths with spaces. */
const shellQuote = (p: string): string => (/[\s"'\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, "\\$1")}"` : p)

/** Split a segment into shell words, keeping quoted runs intact. */
const words = (segment: string): string[] => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []

/**
 * `>`/`>>` redirection targets. `splitSegments` does not split on these, and the
 * `>` needs no leading space (`echo hi>/x`) and may carry an fd (`npm test 2>/x`).
 */
const REDIRECT_RE = />>?\|?\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g

/**
 * The absolute path outside `worktree` this segment reaches, or null.
 *
 * Deliberately NOT keyed on a list of mutating commands: any such list is
 * defeated by one token (`sudo rm …`, `env rm …`, `FOO=1 rm …`, `/bin/rm …`,
 * `xargs rm`), and by every mutator not on it (`perl -i`, `patch`, `tar -C`,
 * `node -e`). So the rule is inverted — in a segment that is not a known
 * READ-ONLY shape, ANY absolute path outside the worktree is treated as an
 * escape. That fails closed on genuinely-outside reads too, which is the correct
 * trade for a guard: the message names the path, and reads of the main tree have
 * a read-only form that stays allowed.
 */
const outsideAbsPath = (segment: string, worktree: string): string | null => {
  const outside = (raw: string): string | null => {
    const w = unquote(raw)
    if (!path.isAbsolute(w)) return null
    const resolved = path.resolve(w)
    return underWorktree(worktree, resolved) ? null : resolved
  }
  // Redirections first: they escape regardless of how read-only the command looks.
  for (const m of segment.matchAll(REDIRECT_RE)) {
    const hit = outside(m[1]!)
    if (hit) return hit
  }
  if (isReadOnlySegment(segment)) return null
  for (const w of words(segment)) {
    // `--work-tree=/repo`, `--git-dir=/repo/.git`: the path rides a flag.
    const hit = outside(w.includes("=") ? w.slice(w.indexOf("=") + 1) : w)
    if (hit) return hit
  }
  return null
}

/**
 * Why this segment escapes the worktree no matter how the chain is pinned, or
 * null. Checked on EVERY segment — a `cd <wt> &&` prefix pins the cwd but does
 * not stop an absolute-path write or a `git -C <outside>` from reaching the main
 * tree, which is how the original pinned-chain hole leaked.
 */
const escapeReason = (segment: string, worktree: string, pinnedDir: string | null): string | null => {
  // `git -C <dir>` acts on that tree whatever the cwd is. A RELATIVE dir escapes
  // too (`git -C ../.. add -A`), so resolve it against the pin before judging.
  const gitDir = gitCDir(segment)
  if (gitDir && !isReadOnlySegment(segment)) {
    const resolved = path.isAbsolute(gitDir) ? path.resolve(gitDir) : path.resolve(pinnedDir ?? worktree, gitDir)
    if (!underWorktree(worktree, resolved)) {
      return (
        `agentic-workflow: this loop is isolated to its worktree ${worktree} — "${segment.trim()}" mutates the tree at ` +
        `${resolved}, which is outside it. Use \`git -C ${worktree} …\`.`
      )
    }
  }
  const target = outsideAbsPath(segment, worktree)
  if (target) {
    return (
      `agentic-workflow: this loop is isolated to its worktree ${worktree} — "${segment.trim()}" reaches ${target}, ` +
      `which is outside it. Read and write only under the worktree.`
    )
  }
  return null
}

/**
 * A `cd` argument this guard cannot resolve to a literal path, and so must never
 * treat as one: `cd -` jumps to `$OLDPWD` (the main tree, for an agent that has
 * been there), `cd ~`/`cd ~user` to a home directory, and anything with `$` or a
 * backtick is assembled at runtime. Resolving these literally made
 * `path.resolve(worktree, "-")` look like an in-bounds subdirectory.
 */
const isUnresolvableCd = (target: string): boolean => target === "-" || target.startsWith("~") || /[$`]/.test(target)

/** Three-way pin verdict: run as-is, run a corrected value, or refuse. */
export type PinVerdict =
  | { readonly action: "allow" }
  | { readonly action: "rewrite"; readonly value: string }
  | { readonly action: "block"; readonly reason: string }

const ALLOW_PIN: PinVerdict = { action: "allow" }
const rewrite = (value: string): PinVerdict => ({ action: "rewrite", value })
const blockPin = (reason: string): PinVerdict => ({ action: "block", reason })

type WalkResult = { readonly ok: true } | { readonly ok: false; readonly reason: string | null }

/**
 * Walk a command's segments against the worktree, starting from `initialPin`.
 * `reason` non-null ⇒ an unconditional escape (no prefix can fix it); null ⇒ the
 * segment merely lacked a pin, which prefixing WOULD fix.
 */
const walk = (command: string, worktree: string, initialPin: string | null): WalkResult => {
  let pinnedDir = initialPin
  for (const segment of splitSegments(command)) {
    // `.+` not `\S+`: real worktree paths can contain spaces (quoted), e.g. under "Claude Code/".
    const cdMatch = /^cd\s+(.+)$/.exec(segment.trim())
    if (cdMatch) {
      const target = unquote(cdMatch[1]!.trim())
      const escapeMsg =
        `agentic-workflow: this loop is isolated to its worktree ${worktree} — "${segment.trim()}" leaves it, so the rest of ` +
        `the command would run outside the worktree. Only \`cd\` into a literal directory under ${worktree}.`
      // `cd -` / `cd ~` / `cd $X` are not paths — never resolve them literally.
      if (isUnresolvableCd(target)) return { ok: false, reason: escapeMsg }
      const resolved: string | null = path.isAbsolute(target)
        ? path.resolve(target)
        : pinnedDir
          ? path.resolve(pinnedDir, target)
          : null
      if (resolved && underWorktree(worktree, resolved)) {
        pinnedDir = resolved
        continue
      }
      return {
        ok: false,
        // Only a genuine escape when the cwd was already known: an unpinned
        // RELATIVE cd is just a missing prefix, which the rewrite fixes.
        reason: pinnedDir || path.isAbsolute(target) ? escapeMsg : null,
      }
    }
    const escape = escapeReason(segment, worktree, pinnedDir)
    if (escape) return { ok: false, reason: escape }
    if (pinnedDir) continue
    const gitDir = gitCDir(segment)
    if (gitDir && path.isAbsolute(gitDir) && underWorktree(worktree, path.resolve(gitDir))) continue
    if (isReadOnlySegment(segment)) continue
    return { ok: false, reason: null }
  }
  return { ok: true }
}

/**
 * Pin one bash command to `worktree`, correcting it where possible.
 *
 * Evaluated in two passes. The first walks the command AS IF it were already
 * prefixed with `cd <wt> && ` — anything that still escapes then is
 * unconditional, so it blocks. The second walks it as written; if that passes,
 * the command runs untouched. Otherwise the only thing wrong is the missing
 * prefix, so it is rewritten in.
 */
export const pinBash = (command: string, worktree: string): PinVerdict => {
  const prefixed = walk(command, worktree, worktree)
  if (!prefixed.ok && prefixed.reason) return blockPin(prefixed.reason)
  if (walk(command, worktree, null).ok) return ALLOW_PIN
  return rewrite(`cd ${shellQuote(worktree)} && ${command}`)
}

/**
 * Boolean view of `pinBash`, kept for callers that cannot act on a rewrite.
 * A rewritable command reads as ALLOWED here: the rewrite is the correct
 * outcome, and a caller that ignores it would otherwise block work the pin can
 * fix. Only unconditional escapes deny.
 */
export const classifyWorktreeBash = (command: string, worktree: string): GuardVerdict => {
  const verdict = pinBash(command, worktree)
  return verdict.action === "block" ? block(verdict.reason) : ALLOW
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

/**
 * Pin one edit/write target to `worktree`, correcting it where possible.
 *
 * The agent session's cwd is the MAIN tree, so the two ways a stage agent misses
 * the worktree are both mechanical and both recoverable:
 *
 *  - a RELATIVE path (`src/a.ts`) — resolve it against the worktree, not the cwd;
 *  - a MAIN-TREE ABSOLUTE path (`<directory>/src/a.ts`) — remap to the worktree
 *    mirror `<worktree>/src/a.ts`. This is the "agent keeps trying to make the
 *    change on the current branch" case.
 *
 * Blocked outright: the worktree's frozen backlog copy (task files are
 * driver-owned and live on the main tree — an edit there rides `feature/<id>`
 * and resurrects the task in the wrong status folder on merge), and any path
 * under neither tree, which has no honest worktree equivalent.
 *
 * `worktree` is checked BEFORE `directory` because the worktree normally lives
 * INSIDE the main tree (`<directory>/.workflow-worktrees/<id>`), so every worktree
 * path is also a main-tree path.
 */
export const pinEditPath = (filePath: string, worktree: string, directory: string, tasksDir: string): PinVerdict => {
  // `~/…` is shell syntax the file tools do not expand: resolving it literally
  // would create a directory actually named `~` inside the worktree.
  if (filePath.startsWith("~")) {
    return blockPin(
      `agentic-workflow: "${filePath}" starts with \`~\`, which file tools do not expand — pass a real absolute path under the worktree ${worktree}.`,
    )
  }
  const wasAbsolute = path.isAbsolute(filePath)
  const resolved = wasAbsolute ? path.resolve(filePath) : path.resolve(worktree, filePath)
  // Git's own metadata is never an edit target, and in a linked worktree
  // `<worktree>/.git` is a FILE, so remapping there fails with a confusing
  // ENOTDIR instead of an explanation.
  if (path.resolve(resolved).split(path.sep).includes(".git")) {
    return blockPin(`agentic-workflow: ${filePath} is inside a .git directory — git metadata is never an edit target.`)
  }
  const refuseTasks = blockPin(
    `agentic-workflow: task files are driver-owned and live on the main tree — the loop records notes and moves itself; ` +
      `do not edit the worktree's frozen ${tasksDir} copy.`,
  )

  if (underWorktree(worktree, resolved)) {
    if (isUnderTasksDir(resolved, worktree, tasksDir)) return refuseTasks
    return wasAbsolute ? ALLOW_PIN : rewrite(resolved)
  }

  // Outside the worktree — remap onto its mirror when the path is main-tree relative.
  const rel = path.relative(path.resolve(directory), resolved)
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    // A MAIN-TREE backlog path is the driver's (or the PLAN stage's) own
    // business and was already ruled on by the backlog-mutation guard, which is
    // the authority here. Defer to it — and never remap it into the worktree,
    // which would put a task file on the feature branch.
    if (isUnderTasksDir(resolved, directory, tasksDir)) return ALLOW_PIN
    return rewrite(path.resolve(worktree, rel))
  }

  return blockPin(
    `agentic-workflow: this loop is isolated to its worktree ${worktree} — ${filePath} is outside both it and the repo ` +
      `at ${directory}, so there is no worktree equivalent. Use a path under the worktree.`,
  )
}
