import path from "node:path"
import type { Log, Shell } from "../host.js"
import { slugify } from "../task/schema.js"
import type { Config, LoopState } from "./state.js"
import {
  addWorktree,
  checkoutBranch,
  currentBranch,
  ensureExcluded,
  isDirty,
  isGitRepo,
  pruneWorktrees,
  removeWorktree,
  worktreeForBranch,
} from "./git.js"

/**
 * Git isolation for one loop's execution. Host-agnostic: parameterized over
 * the host shell and logger, so both the OpenCode driver and the Claude Code
 * MCP server drive the exact same behavior.
 */

export const loopId = (state: LoopState): string =>
  state.task?.id ?? (slugify(state.goal.split("\n")[0] ?? "") || "goal")

/** Absolute path to a task's dedicated worktree under the configured root. Pure. */
export const worktreePathFor = (directory: string, worktreesDir: string, id: string): string =>
  path.resolve(directory, worktreesDir, id)

/** Run the configured worktree-setup command in a fresh worktree. Warn-and-continue. */
const runWorktreeSetup = async ($: Shell, log: Log, config: Config, wtPath: string): Promise<void> => {
  if (!config.worktreeSetup) return
  const out = await $`${{ raw: config.worktreeSetup }}`.cwd(wtPath).quiet().nothrow()
  if (out.exitCode !== 0) {
    await log("warn", `loop: worktreeSetup failed in ${wtPath}: ${out.stderr.toString().trim()}`)
  }
}

/**
 * Isolate execution for this loop. Two modes:
 *
 * - **Worktree mode** (`config.worktreesDir` set): each loop gets its own
 *   `git worktree` on `loop/<id>`, cut from `base`. The human's checkout is
 *   never touched and concurrent drives are safe. If the worktree can't be
 *   created it **throws** — never falls back to shared-tree branch switching,
 *   which could clobber a concurrent drive's checked-out branch.
 * - **Shared-tree mode** (default): checks out `loop/<id>` in the main tree.
 *   Degrades to no isolation (with a warning) outside a git repo, on a
 *   detached HEAD, or when checkout fails.
 *
 * An existing branch (e.g. a recovered run's) is reused, never reset.
 *
 * `baseBranch` (optional) is the branch a fresh `loop/<id>` is cut from; when a
 * host resolves one it wins over the branch `directory` has checked out. Unset
 * ⇒ cut from `currentBranch(directory)` as before.
 */
export const ensureIsolation = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  state: LoopState,
  baseBranch?: string,
): Promise<LoopState> => {
  if (state.git) {
    if (state.git.worktree) {
      // Worktree mode — never touch the shared tree. Recreate a vanished worktree.
      if (!(await isGitRepo($, state.git.worktree))) {
        await pruneWorktrees($, directory)
        if (!(await addWorktree($, directory, state.git.worktree, state.git.branch, state.git.base))) {
          throw new Error(`could not recreate worktree ${state.git.worktree} for ${state.git.branch}`)
        }
        await runWorktreeSetup($, log, config, state.git.worktree)
      }
      return { ...state, isolated: true }
    }
    // `git` is pre-set with no worktree yet. Two ways this happens:
    //  1. A PR-shaped source named the PR's head branch to isolate ONTO (pr-sitter):
    //     `isolated` is still false, so establish real isolation here — a worktree
    //     when `worktreesDir` is set (so the human's main tree is never switched to
    //     the PR branch), else a shared-tree checkout.
    //  2. An already-isolated shared-tree loop being reconciled before a later stage
    //     (`isolated` already true): just make sure the tree is back on its branch.
    if (!state.isolated && config.worktreesDir) {
      await ensureExcluded($, directory, config.worktreesDir)
      const wtPath = worktreePathFor(directory, config.worktreesDir, loopId(state))
      // `git worktree list` includes the MAIN tree as its first entry; if the human
      // (or a prior shared-mode run) left it checked out on this branch,
      // `existing === directory` — adopting it as "the worktree" would isolate ONTO
      // the human's tree, the exact harm this path avoids. Only reuse a SEPARATE
      // worktree; otherwise create one (which fails loudly if the branch is checked
      // out in the main tree, rather than silently committing it).
      const existing = await worktreeForBranch($, directory, state.git.branch)
      if (existing && path.resolve(existing) !== path.resolve(directory)) {
        if (existing !== wtPath) await log("info", `loop: reusing existing worktree ${existing} for ${state.git.branch}`)
        return { ...state, git: { ...state.git, worktree: existing }, isolated: true }
      }
      if (await isGitRepo($, wtPath)) await pruneWorktrees($, directory)
      // `addWorktree` reuses the (already-fetched) head branch as-is — no `-b`.
      if (!(await addWorktree($, directory, wtPath, state.git.branch, state.git.base))) {
        throw new Error(`could not create worktree ${wtPath} for ${state.git.branch} — resolve it, then /agent-loop recover`)
      }
      await runWorktreeSetup($, log, config, wtPath)
      return { ...state, git: { ...state.git, worktree: wtPath }, isolated: true }
    }
    // Shared mode — make sure the tree is on this loop's branch.
    const cur = await currentBranch($, directory)
    if (cur !== state.git.branch && !(await checkoutBranch($, directory, state.git.branch))) {
      await log("warn", `loop: could not return to ${state.git.branch} — building on ${cur ?? "detached HEAD"}`)
    }
    return { ...state, isolated: true }
  }

  if (!(await isGitRepo($, directory))) return state
  // `baseBranch`, when a host resolves one (e.g. the MCP host reading the
  // user's real working tree), overrides the branch `directory` sits on —
  // its checkout is frozen at the main tree, which is usually the default
  // branch. Unset ⇒ today's behavior: cut from `directory`'s current branch.
  const base = baseBranch ?? (await currentBranch($, directory))
  if (!base) {
    await log("warn", "loop: detached HEAD — building without branch isolation")
    return state
  }
  const branch = `loop/${loopId(state)}`

  if (config.worktreesDir) {
    const wtPath = worktreePathFor(directory, config.worktreesDir, loopId(state))
    await ensureExcluded($, directory, config.worktreesDir)
    if (await isDirty($, directory)) {
      await log("info", "loop: main tree has uncommitted changes — they are NOT visible in this loop's worktree")
    }
    // Reuse a worktree already registered for this branch (a recovered run) — but
    // never the main tree itself (`git worktree list` includes it), which would
    // isolate onto the human's checkout.
    const existing = await worktreeForBranch($, directory, branch)
    if (existing && path.resolve(existing) !== path.resolve(directory)) {
      if (existing !== wtPath) await log("info", `loop: reusing existing worktree ${existing} for ${branch}`)
      return { ...state, git: { base, branch, worktree: existing }, isolated: true }
    }
    // A leftover directory with no registration — prune, then let add try.
    if (await isGitRepo($, wtPath)) await pruneWorktrees($, directory)
    if (!(await addWorktree($, directory, wtPath, branch, base))) {
      throw new Error(`could not create worktree ${wtPath} for ${branch} — resolve it, then /agent-loop recover`)
    }
    await runWorktreeSetup($, log, config, wtPath)
    return { ...state, git: { base, branch, worktree: wtPath }, isolated: true }
  }

  if (await isDirty($, directory)) {
    await log(
      "warn",
      "loop: working tree dirty at build start — pre-existing changes will land in this loop's checkpoints",
    )
  }
  if (!(await checkoutBranch($, directory, branch))) {
    await log("warn", `loop: could not check out ${branch} — building without branch isolation`)
    return state
  }
  return { ...state, git: { base, branch }, isolated: true }
}

/**
 * Tear down this loop's isolation. Worktree mode: remove the worktree if it's
 * clean (the branch is kept for human review); a dirty worktree or a failed
 * removal is left in place with a warning. Shared mode: return the main tree to
 * the branch it was on before the loop branched off.
 */
export const teardownIsolation = async ($: Shell, log: Log, directory: string, state: LoopState): Promise<void> => {
  if (!state.git) return
  if (state.git.worktree) {
    if (!(await removeWorktree($, directory, state.git.worktree))) {
      await log(
        "info",
        `loop: worktree ${state.git.worktree} left in place (dirty or locked) — branch ${state.git.branch} holds the committed work`,
      )
    }
    return
  }
  if (!(await checkoutBranch($, directory, state.git.base))) {
    await log("warn", `loop: could not return to ${state.git.base} — still on ${state.git.branch}`)
  }
}
