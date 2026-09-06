import path from "node:path"
import type { Log, Shell } from "../host.js"
import type { Config } from "./state.js"
import { taskBranchPrefix, worktreesDirFor } from "../config.js"
import { defaultBranchName, isAncestor, listBranches, listWorktrees } from "./git.js"
import { releaseWorktreeAt } from "./isolate.js"

/**
 * The loop's leftovers (design 63): worktrees under the configured root and
 * `feature/<id>` branches whose task is no longer on the board — completed,
 * abandoned, removed, or never existed.
 *
 * They accumulate by design: `teardownIsolation` KEEPS a worktree so the next
 * run resumes in it, and the ship gate releases only a `completed/` task's.
 * OpenCode's startup reconcile named worktrees for in-progress/in-review tasks
 * only and stopped there; the Claude host had no equivalent; no host ever
 * enumerated branches. So a repo that ran a hundred tasks carried a hundred
 * branches and nothing said so.
 *
 * One auditor, shared by all three doctors. Report is pure over git's answers;
 * the only repair is `removeOrphanWorktrees`, which goes through
 * `releaseWorktreeAt` — never the main tree, never `--force` (a dirty worktree
 * is left and named), never a branch: a branch with unmerged commits is work,
 * and deleting it is the human's call by hand.
 */
export interface OrphanWorktree {
  readonly path: string
  readonly branch: string | null
  readonly id: string
}

export interface OrphanBranch {
  readonly branch: string
  readonly id: string
  /** Fully merged into the default branch — safe to delete. Null when the default branch could not be resolved. */
  readonly merged: boolean | null
}

export interface OrphanReport {
  readonly worktrees: readonly OrphanWorktree[]
  readonly branches: readonly OrphanBranch[]
  /** The base the branches were judged against, or null. */
  readonly base: string | null
}

export const EMPTY_ORPHANS: OrphanReport = { worktrees: [], branches: [], base: null }

/**
 * Audit one kind's namespace. `liveIds` are the ids of every task still on the
 * board (any non-terminal folder); anything else in the namespace is an orphan.
 * Current-branch mode (`worktreesDirFor` false / no branch prefix) has no
 * namespace and returns empty.
 */
export const auditOrphans = async (
  $: Shell,
  directory: string,
  config: Config,
  kind: string,
  liveIds: ReadonlySet<string>,
): Promise<OrphanReport> => {
  const wtDir = worktreesDirFor(config, kind)
  const prefix = taskBranchPrefix(config, kind)
  if (!wtDir || !prefix) return EMPTY_ORPHANS
  const root = path.resolve(directory, wtDir)
  const main = path.resolve(directory)
  const worktrees: OrphanWorktree[] = []
  for (const w of await listWorktrees($, directory)) {
    const p = path.resolve(w.path)
    // Never the main tree, never a prunable registration (the directory is
    // gone; `git worktree prune` is the fix and every doctor runs it).
    if (p === main || w.prunable || !p.startsWith(`${root}${path.sep}`)) continue
    const id = path.basename(p)
    if (liveIds.has(id)) continue
    worktrees.push({ path: p, branch: w.branch, id })
  }
  const base = await defaultBranchName($, directory)
  const branches: OrphanBranch[] = []
  for (const branch of await listBranches($, directory, prefix)) {
    const id = branch.slice(prefix.length)
    if (!id || liveIds.has(id)) continue
    branches.push({ branch, id, merged: base ? await isAncestor($, directory, branch, base) : null })
  }
  return { worktrees, branches, base }
}

/**
 * Remove the orphan worktrees — the one unambiguous repair. Returns the paths
 * actually removed; a dirty or locked one is left in place (and logged by
 * `releaseWorktreeAt`), a branch is never touched.
 */
export const removeOrphanWorktrees = async ($: Shell, log: Log, directory: string, report: OrphanReport): Promise<string[]> => {
  const removed: string[] = []
  const before = new Set((await listWorktrees($, directory)).map((w) => path.resolve(w.path)))
  for (const o of report.worktrees) {
    await releaseWorktreeAt($, log, directory, o.path, o.branch ?? "(detached)")
  }
  const after = new Set((await listWorktrees($, directory)).map((w) => path.resolve(w.path)))
  for (const o of report.worktrees) if (before.has(o.path) && !after.has(o.path)) removed.push(o.path)
  return removed
}

/** The doctor's lines for a report. Pure. */
export const formatOrphans = (r: OrphanReport): string[] => {
  const lines: string[] = []
  for (const w of r.worktrees) lines.push(`orphan worktree ${w.path}${w.branch ? ` (${w.branch})` : ""} — no task ${w.id} on the board; fix removes it (a dirty one is kept)`)
  for (const b of r.branches) {
    const state = b.merged === null ? "merge state unknown (no default branch)" : b.merged ? `merged into ${r.base ?? "the default branch"} — safe to delete: git branch -d ${b.branch}` : "NOT merged — keeps commits; delete by hand only if the work is unwanted: git branch -D " + b.branch
    lines.push(`orphan branch ${b.branch} — no task ${b.id} on the board; ${state}`)
  }
  return lines
}
