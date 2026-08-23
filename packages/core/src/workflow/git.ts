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
 * The commit HEAD points at, or null (empty repo, not a repo, failure).
 *
 * This is what a current-branch loop (`taskBranch: false`) records as its diff
 * `base`: there the loop cuts no branch, so base and branch would be the SAME
 * ref and `git diff <base>...<branch>` empty. HEAD's sha at the first BUILD is
 * the honest boundary — it is an ancestor of every checkpoint that follows.
 *
 * The shape is validated rather than trusted: `base` flows into the composed
 * stage prompt and into `git diff`, so a stray line of git chatter must read as
 * "no sha" (the caller then refuses) instead of riding into a command.
 */
export const headSha = async ($: Shell, cwd: string): Promise<string | null> => {
  const { ok, stdout } = await run($, cwd, ["rev-parse", "HEAD"])
  return ok && /^[0-9a-f]{7,64}$/.test(stdout) ? stdout : null
}

/**
 * One-line `git diff --shortstat <base>...<branch>` summary — e.g.
 * "3 files changed, 40 insertions(+), 2 deletions(-)" — or null (empty diff,
 * unknown refs, not a repo). Runs by ref from the MAIN checkout, so it works
 * whether the branch is checked out in a worktree or nowhere at all.
 *
 * The shape is validated rather than trusted for the same reason `headSha`'s
 * is: the caller writes this into an audit note whose line format downstream
 * parsers anchor on, so a stray warning line must read as "no stat", never
 * ride into the note.
 */
export const diffShortstat = async ($: Shell, cwd: string, base: string, branch: string): Promise<string | null> => {
  const { ok, stdout } = await run($, cwd, ["diff", "--shortstat", `${base}...${branch}`])
  if (!ok) return null
  const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? ""
  return /^\d+ files? changed(, \d+ insertions?\(\+\))?(, \d+ deletions?\(-\))?$/.test(line) ? line : null
}

/**
 * The repo's default branch, resolved LOCALLY: `origin/HEAD` (set by clone, or
 * by `git remote set-head`), else `init.defaultBranch`, else null.
 *
 * Deliberately never `gh repo view` — `ship-pr` may pay a network round trip
 * because it runs once per ship, but this runs before every fresh BUILD and
 * gates whether the loop starts at all. A default branch that can't be resolved
 * offline must degrade to the caller's fallback, not to a hang.
 */
export const defaultBranchName = async ($: Shell, cwd: string): Promise<string | null> => {
  const head = await run($, cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])
  const fromRemote = head.ok ? head.stdout.replace(/^refs\/remotes\/origin\//, "").trim() : ""
  if (fromRemote) return fromRemote
  const cfg = await run($, cwd, ["config", "--get", "init.defaultBranch"])
  return cfg.ok && cfg.stdout ? cfg.stdout : null
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
 * Lockfiles kept OUT of automatic checkpoints. VERIFY's allowlist permits
 * `npm install`/`npm ci` (an isolated worktree may have no installed deps), and
 * npm rewrites the lockfile on the way through — registry metadata, resolved
 * URLs, lockfileVersion. The next checkpoint's `git add -A` then committed that
 * churn, and REVIEW's diff boundary showed an unexplained lockfile bump the
 * plan never mentioned: a plausible spurious FAIL, or the churn shipped with
 * the feature. A task that LEGITIMATELY changes dependencies commits its
 * lockfile explicitly (the BUILD prompt says so) — an explicit `git add
 * <lockfile>` is untouched by the `:(exclude)` pathspec, which only narrows
 * the automatic `add -A`. The leading `*` matches nested workspaces (git
 * pathspec wildcards cross directory separators).
 */
export const CHECKPOINT_LOCKFILE_EXCLUDES: readonly string[] = ["*package-lock.json", "*npm-shrinkwrap.json", "*pnpm-lock.yaml", "*yarn.lock", "*bun.lock", "*bun.lockb"]

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
 * Whether `branch` exists on `origin` — the side that matters for a PR base,
 * which `branchExists` (local refs) cannot answer. Used only by the ship gate.
 *
 * Three-valued on purpose. `unknown` means the question could not be asked (no
 * remote, no auth, offline), which must NOT read as "absent": the caller refuses
 * a ship on `absent`, and inventing that refusal for a broken remote would block
 * a PR the platform would have accepted.
 *
 * `ls-remote` exits 0 with empty output when nothing matched, so the exit code
 * alone proves nothing — and its pattern matches against the TAIL of a ref path,
 * so `--heads origin 2.4` happily returns `refs/heads/release/2.4`. Both are why
 * this parses stdout and demands an exact `refs/heads/<branch>` line: a
 * substring test would wave through the very typo the caller exists to catch
 * (`release/2.4` vs `release/2.40` — pinned in ship-pr.test.ts).
 */
export const remoteBranchExists = async ($: Shell, cwd: string, branch: string): Promise<"present" | "absent" | "unknown"> => {
  const { ok, stdout } = await run($, cwd, ["ls-remote", "--heads", "origin", branch])
  if (!ok) return "unknown"
  const wanted = `refs/heads/${branch}`
  return stdout.split("\n").some((line) => line.split("\t")[1]?.trim() === wanted) ? "present" : "absent"
}

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
 * The absolute `<git-common-dir>` (`.git` in an ordinary clone; the shared one
 * from any linked worktree), or null outside a repo.
 *
 * The home for per-clone machine state that must NOT be a working-tree file: it
 * is outside every checkout by construction, so nothing there can be swept into
 * a `git add -A`, and it is shared by every worktree of the repo — which is what
 * makes a marker written there visible to a second process.
 */
export const gitCommonDir = async ($: Shell, cwd: string): Promise<string | null> => {
  const { ok, stdout } = await run($, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  return ok && stdout ? stdout : null
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
