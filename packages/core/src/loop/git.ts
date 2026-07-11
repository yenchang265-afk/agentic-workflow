import type { Shell } from "../host.js"

/**
 * Git helpers for the loop's execution isolation. **Impure**: everything here
 * shells out via the host shell. All helpers are best-effort and degrade
 * gracefully — outside a git repo the loop simply runs without isolation, same
 * as before it existed. The one exception to "never pushes" is `pushBranch`,
 * used only by the ship gate (`loop/ship-pr.ts`) to publish a task's branch
 * before opening its PR.
 */

const run = async ($: Shell, cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> => {
  const out = await $`git -C ${cwd} ${args}`.quiet().nothrow()
  return { ok: out.exitCode === 0, stdout: out.stdout.toString().trim() }
}

/** Whether `cwd` is inside a git work tree. */
export const isGitRepo = async ($: Shell, cwd: string): Promise<boolean> =>
  (await run($, cwd, ["rev-parse", "--is-inside-work-tree"])).ok

/** The currently checked-out branch name, or null (detached HEAD / not a repo). */
export const currentBranch = async ($: Shell, cwd: string): Promise<string | null> => {
  const { ok, stdout } = await run($, cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  return ok && stdout && stdout !== "HEAD" ? stdout : null
}

/** Whether the working tree has any uncommitted changes (staged or not). */
export const isDirty = async ($: Shell, cwd: string): Promise<boolean> => {
  const { ok, stdout } = await run($, cwd, ["status", "--porcelain"])
  return ok && stdout.length > 0
}

/**
 * Check out `branch`, creating it from the current HEAD when it doesn't exist
 * yet (an existing branch — e.g. from a recovered run — is reused as-is,
 * never reset). Returns false when the checkout failed.
 */
export const checkoutBranch = async ($: Shell, cwd: string, branch: string): Promise<boolean> => {
  const exists = (await run($, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok
  return (await run($, cwd, exists ? ["checkout", branch] : ["checkout", "-b", branch])).ok
}

/**
 * Stage everything and commit. Returns false when there was nothing to commit
 * or the commit failed — callers treat both as "no checkpoint taken".
 */
export const commitAll = async ($: Shell, cwd: string, message: string): Promise<boolean> => {
  if (!(await run($, cwd, ["add", "-A"])).ok) return false
  return (await run($, cwd, ["commit", "-m", message])).ok
}

/**
 * Stage and commit only the given paths — used to commit backlog mutations
 * (task moves, persisted plans) without sweeping up unrelated working-tree
 * changes. Returns false when nothing was committed.
 */
export const commitPaths = async ($: Shell, cwd: string, paths: readonly string[], message: string): Promise<boolean> => {
  if (paths.length === 0) return false
  if (!(await run($, cwd, ["add", "--", ...paths])).ok) return false
  return (await run($, cwd, ["commit", "-m", message, "--", ...paths])).ok
}

/**
 * Push `branch` to `origin`, setting the upstream (`-u`) so a later plain
 * `git push` from a human continues it. Used only by the ship gate. Returns
 * false on failure (no remote, no auth, rejected, etc.) — callers treat this
 * as "PR not opened", never as a reason to undo the ship.
 */
export const pushBranch = async ($: Shell, cwd: string, branch: string): Promise<boolean> =>
  (await run($, cwd, ["push", "-u", "origin", branch])).ok

/** The committer identity configured for this tree, as `Name <email>`, or null. */
export const gitActor = async ($: Shell, cwd: string): Promise<string | null> => {
  const name = (await run($, cwd, ["config", "user.name"])).stdout
  const email = (await run($, cwd, ["config", "user.email"])).stdout
  if (!name && !email) return null
  return name && email ? `${name} <${email}>` : name || email
}

// --- Worktree isolation (per-task checkouts; see docs/design/improvements/01) ---

/** Whether a local branch ref already exists. */
export const branchExists = async ($: Shell, cwd: string, branch: string): Promise<boolean> =>
  (await run($, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok

/**
 * Create a worktree at `wtPath` checked out to `branch`, cut from `base` (or
 * HEAD) when the branch doesn't exist yet. An existing branch is reused as-is,
 * never reset — same contract as `checkoutBranch`. Returns false on failure.
 */
export const addWorktree = async (
  $: Shell,
  cwd: string,
  wtPath: string,
  branch: string,
  base?: string,
): Promise<boolean> => {
  const exists = await branchExists($, cwd, branch)
  const args = exists
    ? ["worktree", "add", wtPath, branch]
    : ["worktree", "add", "-b", branch, wtPath, base ?? "HEAD"]
  return (await run($, cwd, args)).ok
}

/**
 * Remove the worktree at `wtPath`. Deliberately no `--force`: a dirty worktree
 * (a checkpoint commit that failed) must survive for human inspection rather
 * than be silently discarded. The branch is never touched. Returns false when
 * the worktree was dirty/locked and thus left in place.
 */
export const removeWorktree = async ($: Shell, cwd: string, wtPath: string): Promise<boolean> =>
  (await run($, cwd, ["worktree", "remove", wtPath])).ok

/** Drop registrations for worktrees whose directories have vanished. Safe/no-op otherwise. */
export const pruneWorktrees = async ($: Shell, cwd: string): Promise<void> => {
  await run($, cwd, ["worktree", "prune"])
}

/** One registered worktree: its absolute path and checked-out branch (if any). */
export interface WorktreeEntry {
  readonly path: string
  readonly branch: string | null
}

/** Every registered worktree in the repo (including the main one). Empty on failure. */
export const listWorktrees = async ($: Shell, cwd: string): Promise<WorktreeEntry[]> => {
  const { ok, stdout } = await run($, cwd, ["worktree", "list", "--porcelain"])
  if (!ok) return []
  // Porcelain output is stanzas separated by blank lines:
  //   worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n
  const entries: WorktreeEntry[] = []
  let curPath: string | null = null
  let curBranch: string | null = null
  const flush = () => {
    if (curPath) entries.push({ path: curPath, branch: curBranch })
    curPath = null
    curBranch = null
  }
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      curPath = line.slice("worktree ".length).trim()
    } else if (line.startsWith("branch refs/heads/")) {
      curBranch = line.slice("branch refs/heads/".length).trim()
    }
  }
  flush()
  return entries
}

/** The absolute path of the worktree checked out to `branch`, or null if none. */
export const worktreeForBranch = async ($: Shell, cwd: string, branch: string): Promise<string | null> => {
  const found = (await listWorktrees($, cwd)).find((w) => w.branch === branch)
  return found?.path ?? null
}

/**
 * Idempotently exclude `rel` from git status via `<git-common-dir>/info/exclude`
 * — keeps a nested worktrees directory out of the human's `git status` without
 * touching the tracked `.gitignore`. Best-effort.
 */
export const ensureExcluded = async ($: Shell, cwd: string, rel: string): Promise<void> => {
  // --path-format=absolute so the append lands regardless of the shell's own cwd.
  const { ok, stdout } = await run($, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!ok || !stdout) return
  const entry = `/${rel.replace(/^\/+|\/+$/g, "")}/`
  const excludeFile = `${stdout}/info/exclude`
  const already = await $`grep -qxF ${entry} ${excludeFile}`.quiet().nothrow()
  if (already.exitCode === 0) return
  await $`mkdir -p ${stdout}/info`.quiet().nothrow()
  await $`printf '%s\n' ${entry} >> ${excludeFile}`.quiet().nothrow()
}
