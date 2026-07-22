import fs from "node:fs"
import path from "node:path"
import type { Shell } from "../host.js"

/**
 * Git helpers for the loop's execution isolation. **Impure**: everything here
 * shells out via the host shell. All helpers are best-effort and degrade
 * gracefully — outside a git repo the loop simply runs without isolation, same
 * as before it existed. The one exception to "never pushes" is `pushBranch`,
 * used only by the ship gate (`workflow/ship-pr.ts`) to publish a task's branch
 * before opening its PR.
 */

const run = async ($: Shell, cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const out = await $`git -C ${cwd} ${args}`.quiet().nothrow()
  return { ok: out.exitCode === 0, stdout: out.stdout.toString().trim(), stderr: out.stderr.toString().trim() }
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
 *
 * `excludes` (repo-relative paths) are kept OUT of the checkpoint via git's
 * `:(exclude)` pathspec — hosts pass the backlog dir when checkpointing a
 * worktree, so its checkout-time frozen copy of `docs/tasks` never rides the
 * feature branch (task-file lifecycle lives on the main tree).
 */
export const commitAll = async ($: Shell, cwd: string, message: string, excludes?: readonly string[]): Promise<boolean> => {
  const addArgs =
    excludes && excludes.length > 0 ? ["add", "-A", "--", ".", ...excludes.map((e) => `:(exclude)${e}`)] : ["add", "-A"]
  if (!(await run($, cwd, addArgs)).ok) return false
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
 * never reset — same contract as `checkoutBranch`.
 *
 * Returns git's own stderr alongside `ok`: a failure here aborts the run, and
 * the reason ("already exists", "already checked out", …) is the only thing
 * that makes it actionable — swallowing it left the caller's throw unusable.
 */
export const addWorktree = async (
  $: Shell,
  cwd: string,
  wtPath: string,
  branch: string,
  base?: string,
): Promise<{ ok: boolean; error: string }> => {
  const exists = await branchExists($, cwd, branch)
  const args = exists
    ? ["worktree", "add", wtPath, branch]
    : ["worktree", "add", "-b", branch, wtPath, base ?? "HEAD"]
  const { ok, stderr } = await run($, cwd, args)
  return { ok, error: stderr }
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

/**
 * One registered worktree: its absolute path, checked-out branch (if any), and
 * whether git considers it prunable — the registration survives after the
 * directory is deleted, so a prunable entry names a path that isn't there.
 */
export interface WorktreeEntry {
  readonly path: string
  readonly branch: string | null
  readonly prunable: boolean
}

/** Every registered worktree in the repo (including the main one). Empty on failure. */
export const listWorktrees = async ($: Shell, cwd: string): Promise<WorktreeEntry[]> => {
  const { ok, stdout } = await run($, cwd, ["worktree", "list", "--porcelain"])
  if (!ok) return []
  // Porcelain output is stanzas separated by blank lines:
  //   worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n
  // A worktree whose directory vanished carries a trailing `prunable <reason>`.
  const entries: WorktreeEntry[] = []
  let curPath: string | null = null
  let curBranch: string | null = null
  let curPrunable = false
  const flush = () => {
    if (curPath) entries.push({ path: curPath, branch: curBranch, prunable: curPrunable })
    curPath = null
    curBranch = null
    curPrunable = false
  }
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      curPath = line.slice("worktree ".length).trim()
    } else if (line.startsWith("branch refs/heads/")) {
      curBranch = line.slice("branch refs/heads/".length).trim()
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      curPrunable = true
    }
  }
  flush()
  return entries
}

/**
 * The absolute path of the LIVE worktree checked out to `branch`, or null if none.
 * Prunable entries are skipped: adopting one as isolation pins the stage to a
 * directory that no longer exists, so callers must recreate it instead.
 */
export const worktreeForBranch = async ($: Shell, cwd: string, branch: string): Promise<string | null> => {
  const found = (await listWorktrees($, cwd)).find((w) => w.branch === branch && !w.prunable)
  return found?.path ?? null
}

/**
 * Sparse-checkout `rel` OUT of the worktree at `wtPath`, so the directory never
 * materializes there at all.
 *
 * Used for the backlog: `<tasksDir>/` is tracked, so `git worktree add` checks
 * out a frozen copy of every task file into the worktree. That copy is inert but
 * actively misleading — a stage agent reads it as the live backlog and tries to
 * edit it, when task files are driver-owned and live on the MAIN tree. Removing
 * it from disk is the honest fix; the edit-time refusal in `worktree-guard` and
 * the `:(exclude)` checkpoint arg stay as backstops for the fallback path below.
 *
 * `--no-cone` because the pattern is a negation, which cone mode cannot express.
 * Returns false (caller warns and continues) when sparse-checkout is unavailable
 * or declines — the worktree is then exactly what it is today.
 *
 * Two sharp edges this handles:
 *  - `sparse-checkout set` exits 0 while WARNING "not up to date and were left
 *    despite sparse patterns" when the excluded path is dirty (an adopted older
 *    worktree with local edits). Reporting success there would leave the copy on
 *    disk with nothing logged, so the warning is treated as failure.
 *  - `sparse-checkout init` sets `extensions.worktreeConfig=true` on the SHARED
 *    repo config, permanently and for every worktree. That is safe for ordinary
 *    repos but interacts with `core.worktree`/`core.bare` (separate-gitdir
 *    setups), so failure here must stay non-fatal.
 */
export const excludeFromWorktree = async ($: Shell, wtPath: string, rel: string): Promise<boolean> => {
  const dir = rel.replace(/^\/+|\/+$/g, "")
  if (!dir) return false
  if (!(await run($, wtPath, ["sparse-checkout", "init", "--no-cone"])).ok) return false
  // `/*` keeps everything else; the negation drops just this subtree.
  const set = await run($, wtPath, ["sparse-checkout", "set", "/*", `!/${dir}/`])
  if (!set.ok || /not up to date/i.test(set.stderr)) return false
  // Trust the outcome, not the exit code: confirm the path is actually gone.
  return !fs.existsSync(path.join(wtPath, dir))
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
