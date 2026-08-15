import path from "node:path"
import { acquireOrSweepMarker, releaseMarker, restampMarker, staleClaimMinutes } from "../claim-marker.js"
import { taskBranchFor, taskBranchPrefix, worktreesDirFor } from "../config.js"
import { writeFileAtomic } from "../fsatomic.js"
import type { Log, Shell } from "../host.js"
import { slugify } from "../task/schema.js"
import type { Config, WorkflowState } from "./state.js"
import {
  addWorktree,
  branchExists,
  checkoutBranch,
  currentBranch,
  defaultBranchName,
  ensureExcluded,
  excludeFromWorktree,
  gitCommonDir,
  headSha,
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

export const workflowId = (state: WorkflowState): string =>
  state.task?.id ?? (slugify(state.goal.split("\n")[0] ?? "") || "goal")

/** The kind whose branch policy applies to this loop; an unstamped state is engineering. */
const workflowKind = (state: WorkflowState): string => state.kind ?? "engineering"

// --- Current-branch mode: one run per working tree ---

/**
 * The cross-process lock for `taskBranch: false`.
 *
 * The OpenCode driver already serializes drives per tree (`executingDirs`), but
 * that is a module-level Set in ONE plugin instance — blind to a second editor
 * window, to the Claude MCP server, and to the hub. In shared-tree mode a
 * collision costs a branch switch under a running build; here it costs a WRONG
 * VERDICT: this mode measures its work as `<sha at BUILD>...<branch>`, so a
 * second run's commits land INSIDE the first's diff boundary and REVIEW grades
 * code nobody planned. "One run per branch" is the whole safety story of the
 * mode, so it needs a lock a second process can see.
 *
 * A mkdir marker with the claim markers' staleness contract, for the reason
 * those have one: a SIGKILLed run must not wedge the repo forever. Takeover goes
 * through `acquireOrSweepMarker` (atomic rename-aside), never a bare
 * rmdir+mkdir — two sweepers would otherwise both "win".
 *
 * It lives under `<git-common-dir>`, NOT in the backlog beside the state
 * snapshots, because this is the one mode whose checkpoints `git add -A` the
 * human's own tree: a marker inside the working tree rode straight into the
 * user's feature commits (caught by `current-branch.git.test.ts`). The
 * `tasksDir` fallback only covers a repo whose common dir can't be resolved,
 * where there is no `git add -A` to be swept by either.
 */
const currentBranchLockDir = async ($: Shell, directory: string, tasksDir: string): Promise<string> => {
  const common = await gitCommonDir($, directory)
  return common ? path.join(common, "agentic-workflow", "current-branch") : path.join(directory, tasksDir, "runs", ".current-branch")
}

const lockOwnerPath = (markerDir: string): string => path.join(markerDir, "owner.json")

const readLockOwner = async ($: Shell, markerDir: string): Promise<{ id?: string; branch?: string } | null> => {
  const out = await $`cat ${lockOwnerPath(markerDir)}`.quiet().nothrow()
  if (out.exitCode !== 0) return null
  try {
    return JSON.parse(out.stdout.toString()) as { id?: string; branch?: string }
  } catch {
    return null // a torn owner file only costs the refusal message its detail
  }
}

/**
 * Take (or keep) this tree's current-branch lock for `id`. Throws when another
 * workflow holds it.
 *
 * Idempotent on our OWN id rather than acquire-once, because it is called at
 * every stage boundary and on `recover` — a resumed run enters through the
 * reconcile arm, which never had a chance to acquire, and would otherwise run
 * unlocked. Re-taking our own marker restamps it, which is what keeps a live
 * multi-stage run from aging into a sweep.
 */
const holdCurrentBranchLock = async (
  $: Shell,
  directory: string,
  config: Config,
  id: string,
  branch: string,
): Promise<void> => {
  const markerDir = await currentBranchLockDir($, directory, config.tasksDir)
  if (await acquireOrSweepMarker($, markerDir, staleClaimMinutes(config.stageTimeoutMinutes))) {
    await writeFileAtomic($, lockOwnerPath(markerDir), JSON.stringify({ id, branch, pid: process.pid }))
    return
  }
  const owner = await readLockOwner($, markerDir)
  if (owner?.id === id) {
    await restampMarker($, markerDir)
    return
  }
  throw new Error(
    `another workflow is already building on this working tree: ${owner?.id ?? "an unnamed run"}` +
      `${owner?.branch ? ` on ${owner.branch}` : ""}. With taskBranch: false every loop shares one branch, so two ` +
      `runs would land inside each other's diff. Let it finish (or stop/abandon it), then start this one.`,
  )
}

/**
 * Whether ANOTHER workflow now owns this tree's current-branch lock — false
 * outside current-branch mode, and false when the marker is absent or ownerless
 * (debris from a crashed acquire; nothing live to protect).
 *
 * This is the terminal paths' guard: a stage boundary re-runs
 * `holdCurrentBranchLock`, which throws on a rival — but the DRIVE-END paths
 * (runStop/runDone, a host's error arm) run with no re-hold in front of them,
 * so after this run's lock was swept and re-taken they would otherwise
 * `git add -A` the rival's in-flight work into a checkpoint of their own.
 */
export const rivalHoldsCurrentBranchLock = async (
  $: Shell,
  directory: string,
  config: Config,
  state: WorkflowState,
): Promise<boolean> => {
  if (!state.git?.onCurrentBranch) return false
  const markerDir = await currentBranchLockDir($, directory, config.tasksDir)
  const owner = await readLockOwner($, markerDir)
  return Boolean(owner?.id && owner.id !== workflowId(state))
}

/**
 * Drop this tree's current-branch lock — but ONLY when `id` still owns it.
 * Best-effort; the owner file goes first so `rmdir` can succeed.
 *
 * The owner check is load-bearing, not hygiene: this run's lock can go stale
 * (a long stage plus the check phase can outlive the sweep window) and be
 * re-taken by a rival; a blind release here then frees the RIVAL's live lock,
 * letting a third run in beside it — the two-runs-in-one-diff corruption the
 * lock exists to prevent. An absent or unreadable owner file still releases:
 * healthy owners are written atomically, so that is crashed-acquire debris.
 */
export const releaseCurrentBranchLock = async ($: Shell, log: Log, directory: string, config: Config, id: string): Promise<void> => {
  const markerDir = await currentBranchLockDir($, directory, config.tasksDir)
  const owner = await readLockOwner($, markerDir)
  if (owner?.id && owner.id !== id) {
    await log("warn", `loop: not releasing this tree's current-branch lock — "${owner.id}" holds it now (this run's hold was swept and re-taken)`)
    return
  }
  await $`rm -f ${lockOwnerPath(markerDir)}`.quiet().nothrow()
  await releaseMarker($, markerDir, log)
}

/**
 * Refuse to build on the repo's default branch in current-branch mode.
 *
 * This mode's checkpoints are `git add -A && git commit` in the HUMAN's tree, so
 * a run started from `main` commits loop work straight onto the default branch.
 * Every other failure in this file degrades to a warning; this one throws,
 * because there is no version of it a user wanted.
 *
 * Detection is local (`defaultBranchName`) — never `gh repo view`, which would
 * put a network round trip in front of every fresh BUILD. When it can't be
 * resolved, the fallback tests the CURRENT branch name against the two
 * conventional ones: a membership test cannot mis-refuse a `feature/x` checkout
 * the way a "does main exist?" probe would.
 */
const assertNotDefaultBranch = async ($: Shell, log: Log, directory: string, branch: string): Promise<void> => {
  const detected = await defaultBranchName($, directory)
  const guarded = detected ? [detected] : ["main", "master"]
  if (!guarded.includes(branch)) return
  if (!detected) {
    await log("info", `loop: could not determine this repo's default branch — refusing on the conventional name "${branch}"`)
  }
  throw new Error(
    `taskBranch is false and HEAD is on "${branch}", this repo's default branch — the loop's checkpoints ` +
      `(\`git add -A\`) would commit onto it. Check out a working branch first (\`git checkout -b my-work\`), ` +
      `or set "taskBranch" to a prefix (e.g. "feature/") so the loop cuts its own.`,
  )
}

/**
 * The ref a fresh work branch is cut from — never one of this loop's OWN.
 *
 * `teardownIsolation` deliberately leaves a shared tree parked on
 * `<prefix><prev-id>`, so "cut from whatever is checked out" would stack task N+1
 * on task N: REVIEW grades `base...branch`, and both that diff and the PR would
 * carry the earlier task's commits as if this run had written them. Re-basing off
 * the repo's default branch is what breaks the chain, and it belongs HERE rather
 * than at teardown because it is also correct for a tree the human parked on a
 * work branch themselves.
 *
 * Only the loop's own namespace is redirected. A human sitting on `my-work` gets
 * cut from `my-work` — that is a deliberate base, and hijacking it to the default
 * branch would throw away the very thing they set up.
 *
 * Detection is local (`defaultBranchName`, for the reason `assertNotDefaultBranch`
 * gives), and the result must EXIST: `init.defaultBranch` names a branch the repo
 * may never have created, and `checkoutBranch` would then invent it from the
 * parked branch — the stacking bug wearing the default branch's name. Anything
 * unresolvable degrades to the parked branch with a warning: a noisy diff is
 * recoverable, and refusing to start costs the whole run.
 */
const baseOffTaskBranch = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  kind: string,
  resolved: string,
): Promise<string> => {
  const prefix = taskBranchPrefix(config, kind)
  if (!prefix || !resolved.startsWith(prefix)) return resolved
  const detected = await defaultBranchName($, directory)
  if (!detected || !(await branchExists($, directory, detected))) {
    await log(
      "warn",
      `loop: the tree is parked on ${resolved} from a previous run and this repo's default branch could not be resolved — cutting from ${resolved}, so this run's diff may carry that task's commits too`,
    )
    return resolved
  }
  await log(
    "info",
    `loop: the tree is parked on ${resolved} from a previous run — cutting from ${detected} instead; check out the base you want first to override`,
  )
  return detected
}

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
 * Keep the backlog out of the worktree. `<tasksDir>/` is tracked, so without
 * this every worktree carries a frozen copy of every task file that a stage
 * agent mistakes for the live backlog. Idempotent, so it also cleans up
 * worktrees created before this existed. Warn-and-continue: on a git without
 * `sparse-checkout` the worktree keeps the copy and the edit-time refusal in
 * `worktree-guard` remains the control.
 */
const excludeBacklog = async ($: Shell, log: Log, config: Config, wtPath: string): Promise<void> => {
  if (await excludeFromWorktree($, wtPath, config.tasksDir)) return
  await log("info", `loop: could not sparse-checkout ${config.tasksDir} out of ${wtPath} — its frozen backlog copy stays on disk`)
}

/** Everything a worktree needs after it exists, whether freshly added or adopted. */
const prepareWorktree = async ($: Shell, log: Log, config: Config, wtPath: string, fresh: boolean): Promise<void> => {
  await excludeBacklog($, log, config, wtPath)
  if (fresh) await runWorktreeSetup($, log, config, wtPath)
}

/**
 * Isolate execution for this loop. Three modes, in the order they are chosen:
 *
 * - **Current-branch mode** (`taskBranch: false`): the loop cuts nothing and
 *   moves nothing — BUILD/VERIFY/REVIEW run in the main tree on the branch it
 *   already had checked out, for the human who is already on the branch this
 *   work belongs on. Isolation here is a RECORDED BOUNDARY, not a moved tree:
 *   `base` is HEAD's sha at the first BUILD, because base and branch name the
 *   same ref and a branch-name base would make the review diff empty. Forces
 *   worktrees off (git will not check one branch out twice), refuses to start on
 *   the default branch, and holds a cross-process one-run-per-tree lock.
 * - **Worktree mode** (`worktreesDir` set — the default): each loop gets its own
 *   `git worktree` on `<taskBranch><id>`, cut from `base`. The human's checkout
 *   is never touched and concurrent drives are safe. If the worktree can't be
 *   created it **throws** — never falls back to shared-tree branch switching,
 *   which could clobber a concurrent drive's checked-out branch. The worktree
 *   outlives the run: it is created on a task's first BUILD and removed only
 *   when the task ships (`releaseWorktree`), so every later run — a retry after
 *   the iteration cap, a `recover` after ESC, a `replan` bounce out of
 *   `in-progress/` — resumes in the same directory on top of the previous
 *   iteration's work and its `worktreeSetup` output.
 * - **Shared-tree mode** (`worktreesDir: false`): checks out `<taskBranch><id>`
 *   in the main tree. Degrades to no isolation (with a warning) outside a git
 *   repo, on a detached HEAD, or when checkout fails.
 *
 * An existing branch (e.g. a recovered run's) is reused, never reset.
 *
 * `baseBranch` (optional) is the branch a fresh work branch is cut from; when a
 * host resolves one it wins over the branch `directory` has checked out. Unset
 * ⇒ cut from `currentBranch(directory)` as before. It is deliberately NOT
 * honored in current-branch mode — it names a branch in a different tree, and
 * acting on it would mean the checkout this mode exists to avoid.
 */
export const ensureIsolation = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  state: WorkflowState,
  baseBranch?: string,
): Promise<WorkflowState> => {
  const kind = workflowKind(state)
  const wtDir = worktreesDirFor(config, kind)
  const currentBranchMode = taskBranchPrefix(config, kind) === null
  if (state.git) {
    if (state.git.worktree) {
      // Worktree mode — never touch the shared tree. Recreate a vanished worktree.
      if (!(await isGitRepo($, state.git.worktree))) {
        await pruneWorktrees($, directory)
        const added = await addWorktree($, directory, state.git.worktree, state.git.branch, state.git.base)
        if (!added.ok) {
          throw new Error(`could not recreate worktree ${state.git.worktree} for ${state.git.branch}${added.error ? ` — ${added.error}` : ""}`)
        }
        await prepareWorktree($, log, config, state.git.worktree, true)
      } else {
        await excludeBacklog($, log, config, state.git.worktree)
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
    if (!state.isolated && wtDir) {
      await ensureExcluded($, directory, wtDir)
      const wtPath = worktreePathFor(directory, wtDir, workflowId(state))
      // `git worktree list` includes the MAIN tree as its first entry; if the human
      // (or a prior shared-mode run) left it checked out on this branch,
      // `existing === directory` — adopting it as "the worktree" would isolate ONTO
      // the human's tree, the exact harm this path avoids. Only reuse a SEPARATE
      // worktree; otherwise create one (which fails loudly if the branch is checked
      // out in the main tree, rather than silently committing it).
      const existing = await worktreeForBranch($, directory, state.git.branch)
      if (existing && path.resolve(existing) !== path.resolve(directory)) {
        if (existing !== wtPath) await log("info", `loop: reusing existing worktree ${existing} for ${state.git.branch}`)
        await excludeBacklog($, log, config, existing)
        return { ...state, git: { ...state.git, worktree: existing }, isolated: true }
      }
      if (await isGitRepo($, wtPath)) await pruneWorktrees($, directory)
      // `addWorktree` reuses the (already-fetched) head branch as-is — no `-b`.
      const added = await addWorktree($, directory, wtPath, state.git.branch, state.git.base)
      if (!added.ok) {
        throw new Error(
          `could not create worktree ${wtPath} for ${state.git.branch}${added.error ? ` — ${added.error}` : ""} — resolve it, then /agentic-workflow:engineering recover`,
        )
      }
      await prepareWorktree($, log, config, wtPath, true)
      return { ...state, git: { ...state.git, worktree: wtPath }, isolated: true }
    }
    if (state.git.onCurrentBranch) {
      // Split on the STATE, not the config: a source-driven kind whose `git` was
      // pre-set must keep reconciling by checkout even under `taskBranch: false`,
      // and a run that STARTED in current-branch mode must keep its contract even
      // if the config changed under it.
      //
      // This loop owns no branch of its own, so there is nothing to check out —
      // switching the human's tree is the exact thing the mode exists to avoid,
      // and `base` is a sha, not a branch. Verify and re-take the lock only.
      const cur = await currentBranch($, directory)
      if (cur !== state.git.branch) {
        // NOT `isolated`, for the reason spelled out in the shared arm below:
        // it is the sole gate on every main-tree write, and this run's
        // `git add -A` must not land on a branch the human moved to.
        const why = `the working tree moved from ${state.git.branch} to ${cur ?? "detached HEAD"} mid-run — refusing to move it back`
        await log("warn", `loop: ${why}`)
        return { ...state, isolated: false, isolationWarning: why }
      }
      await holdCurrentBranchLock($, directory, config, workflowId(state), state.git.branch)
      return { ...state, isolated: true }
    }
    // Shared mode — make sure the tree is on this loop's branch.
    const cur = await currentBranch($, directory)
    if (cur !== state.git.branch && !(await checkoutBranch($, directory, state.git.branch))) {
      // NOT `isolated` — same answer the first-time shared path gives to the same
      // failure below. `isolated` is the sole gate on every main-tree write
      // (`closeIsolation` returns early without it), so claiming it here made
      // `commitAll` `git add -A` the BUILD diff AND the whole backlog onto
      // whatever branch the human happened to be on — `cur` can be the default
      // branch — and then `teardownIsolation` checked them out off it. The work
      // also never reached the loop's branch, so the later ship pushed one that
      // had none of it.
      const why = `could not return to ${state.git.branch} — building on ${cur ?? "detached HEAD"} without branch isolation`
      await log("warn", `loop: ${why}`)
      return { ...state, isolated: false, isolationWarning: why }
    }
    return { ...state, isolated: true }
  }

  if (!(await isGitRepo($, directory))) return state

  if (currentBranchMode) {
    if (config.worktreesDir) {
      // Never silent: `worktreesDir` keeps its truthy default, so this is the
      // one place a user learns their configured value was dropped rather than
      // obeyed. Logged HERE, where the decision is taken — the reconcile arm
      // above runs at every stage boundary and would repeat it per stage.
      await log(
        "info",
        `loop: taskBranch is false — worktree isolation (worktreesDir: ${config.worktreesDir}) is off for this run; git cannot check one branch out twice`,
      )
    }
    const branch = await currentBranch($, directory)
    if (!branch) {
      await log("warn", "loop: detached HEAD — building without branch isolation")
      return { ...state, isolationWarning: "detached HEAD — building without branch isolation" }
    }
    if (baseBranch && baseBranch !== branch) {
      // Noted, never acted on: `baseBranch` names a branch in the host's own
      // tree, and honoring it here would mean a checkout.
      await log("info", `loop: taskBranch is false — building on ${directory}'s branch ${branch}, not the resolved base ${baseBranch}`)
    }
    await assertNotDefaultBranch($, log, directory, branch)
    await holdCurrentBranchLock($, directory, config, workflowId(state), branch)
    if (await isDirty($, directory)) {
      // A warning, not `isolationWarning`: both hosts render that field as
      // "BUILD running WITHOUT isolation", which is false here and would tell
      // the user the opposite of what happened.
      await log(
        "warn",
        `loop: ${branch} has uncommitted changes and taskBranch is false — this loop's checkpoints \`git add -A\`, so those changes ride into its commits. Commit or stash them first to keep them separate.`,
      )
    }
    // The diff boundary. Base and branch are the same ref here, so a branch-name
    // base makes `git diff <base>...<branch>` empty and REVIEW sees nothing.
    // HEAD's sha at the first BUILD is the honest boundary: it is an ancestor of
    // every checkpoint that follows, so the `...` form equals a plain two-dot diff.
    const base = await headSha($, directory)
    if (!base) {
      // The lock above is already held; leaving it wedges the tree for every
      // later run until the stale sweep, with a refusal naming a run that never
      // started. Same rule as the claim markers: every way out releases.
      await releaseCurrentBranchLock($, log, directory, config, workflowId(state))
      throw new Error(
        `could not read HEAD in ${directory} — taskBranch: false needs at least one commit to measure this run's work against`,
      )
    }
    return { ...state, git: { base, branch, onCurrentBranch: true }, isolated: true }
  }

  // `baseBranch`, when a host resolves one (e.g. the MCP host reading the
  // user's real working tree), overrides the branch `directory` sits on —
  // its checkout is frozen at the main tree, which is usually the default
  // branch. Unset ⇒ today's behavior: cut from `directory`'s current branch.
  const resolved = baseBranch ?? (await currentBranch($, directory))
  if (!resolved) {
    await log("warn", "loop: detached HEAD — building without branch isolation")
    return { ...state, isolationWarning: "detached HEAD — building without branch isolation" }
  }
  // A shared tree is left ON the last run's work branch, so what is checked out is
  // not automatically a legitimate base. Ahead of the `wtDir` split, so worktree
  // mode's `addWorktree(…, base)` is protected by the same rule.
  const base = await baseOffTaskBranch($, log, directory, config, kind, resolved)
  // Non-null: `currentBranchMode` is the only way this returns null, and it returned above.
  const branch = taskBranchFor(config, kind, workflowId(state)) as string

  if (wtDir) {
    const wtPath = worktreePathFor(directory, wtDir, workflowId(state))
    await ensureExcluded($, directory, wtDir)
    if (await isDirty($, directory)) {
      await log("info", "loop: main tree has uncommitted changes — they are NOT visible in this loop's worktree")
    }
    // Reuse a worktree already registered for this branch (a recovered run) — but
    // never the main tree itself (`git worktree list` includes it), which would
    // isolate onto the human's checkout.
    const existing = await worktreeForBranch($, directory, branch)
    if (existing && path.resolve(existing) !== path.resolve(directory)) {
      if (existing !== wtPath) await log("info", `loop: reusing existing worktree ${existing} for ${branch}`)
      await excludeBacklog($, log, config, existing)
      return { ...state, git: { base, branch, worktree: existing }, isolated: true }
    }
    // A leftover directory with no registration — prune, then let add try.
    if (await isGitRepo($, wtPath)) await pruneWorktrees($, directory)
    const added = await addWorktree($, directory, wtPath, branch, base)
    if (!added.ok) {
      throw new Error(
        `could not create worktree ${wtPath} for ${branch}${added.error ? ` — ${added.error}` : ""} — resolve it, then /agentic-workflow:engineering recover`,
      )
    }
    await prepareWorktree($, log, config, wtPath, true)
    return { ...state, git: { base, branch, worktree: wtPath }, isolated: true }
  }

  if (await isDirty($, directory)) {
    await log(
      "warn",
      "loop: working tree dirty at build start — pre-existing changes will land in this loop's checkpoints",
    )
  }
  // Land on `base` BEFORE cutting: `checkout -b` takes whatever HEAD is, and
  // teardown leaves this tree on the last run's work branch, so cutting straight
  // from here is how task N+1 ends up containing task N. `branchExists` gates it
  // because `checkoutBranch` would CREATE a missing `base` from the parked branch
  // rather than fail — the same stacking, under the base's name.
  let cutFrom = base
  const parked = await currentBranch($, directory)
  if (parked && parked !== base) {
    const landed = (await branchExists($, directory, base)) && (await checkoutBranch($, directory, base))
    if (!landed) {
      // Never claim a base the branch was not cut from — `base` is REVIEW's diff
      // boundary, and a fictional one grades the wrong range. Report where we
      // stand and carry on: a wider diff beats no run at all.
      await log("warn", `loop: could not check out ${base} — cutting ${branch} from ${parked} instead`)
      cutFrom = parked
    }
  }
  if (!(await checkoutBranch($, directory, branch))) {
    await log("warn", `loop: could not check out ${branch} — building without branch isolation`)
    return { ...state, isolationWarning: `could not check out ${branch} — building without branch isolation` }
  }
  return { ...state, git: { base: cutFrom, branch }, isolated: true }
}

/**
 * Tear down this loop's isolation at the end of a run.
 *
 * Worktree mode: the worktree is **kept**. A run ending is not the task ending
 * — a stop at the iteration cap, an ESC interrupt, or a crash all expect a
 * later run to continue the same work, and tearing the directory down forced
 * every one of those to re-`worktree add` and re-run `worktreeSetup`. That
 * round-trip is slow on `/mnt/c` and intermittently fails outright, which
 * killed the loop instead of resuming it. The caller has already checkpointed,
 * so the retained worktree is clean and `ensureIsolation` adopts it as-is next
 * run. Removal belongs to the ship gate — see `releaseWorktree`.
 *
 * Current-branch mode returns the one-run-per-tree lock and otherwise does
 * NOTHING: the loop never moved the tree, and `base` is a sha — `checkoutBranch`
 * falls through to `git checkout -b <base>` when the ref doesn't resolve as a
 * branch, so "returning to base" here would invent a branch named after a commit
 * and strand the human on it.
 *
 * Shared mode does nothing either — and that is a REVERSAL. It used to check the
 * main tree back out onto `base`, and the human's next act after a run is always
 * the work branch: read the diff, amend, push, open the PR. The checkout put them
 * one branch away from all of it, silently, right after the toast that said the
 * work was ready. Staying is also the honest report of where the commits are.
 *
 * Do NOT restore it "so the next run cuts from a clean base" — that job belongs to
 * `ensureIsolation`, which pins the base at the START of a run (`baseOffTaskBranch`
 * + the shared arm's pre-checkout). A checkout here buys that nothing and re-breaks
 * the ergonomics.
 */
export const teardownIsolation = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  state: WorkflowState,
): Promise<void> => {
  if (!state.git) return
  if (state.git.worktree) {
    await log("info", `loop: worktree ${state.git.worktree} kept on ${state.git.branch} — the next run resumes in it`)
    return
  }
  if (state.git.onCurrentBranch) {
    await releaseCurrentBranchLock($, log, directory, config, workflowId(state))
    await log("info", `loop: stayed on ${state.git.branch} — this run's commits are on it, since ${state.git.base.slice(0, 8)}`)
    return
  }
  await log("info", `loop: stayed on ${state.git.branch} — this run's commits are on it, cut from ${state.git.base}`)
}

/**
 * Remove a shipped task's worktree — the one point in the lifecycle where the
 * task is finished and the directory is genuinely disposable. Called by the
 * ship gate after the task reached `completed/`; the work branch is never
 * touched, so the PR and the human's review keep working.
 *
 * Best-effort and never throws: a dirty or locked worktree (`removeWorktree`
 * deliberately omits `--force`) is left in place with an info log rather than
 * silently discarding work, and a ship must never fail because of cleanup.
 */
export const releaseWorktree = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  id: string,
  kind = "engineering",
): Promise<void> => {
  const wtDir = worktreesDirFor(config, kind)
  // Also the current-branch exit: `worktreesDirFor` is false there, and that
  // mode has no worktree to release in the first place.
  if (!wtDir) return
  try {
    const branch = taskBranchFor(config, kind, id)
    if (!branch) return
    // `git worktree list` includes the MAIN tree — removing that is the one
    // outcome this must never produce (same guard as `ensureIsolation`).
    const registered = await worktreeForBranch($, directory, branch)
    const wtPath =
      registered && path.resolve(registered) !== path.resolve(directory)
        ? registered
        : worktreePathFor(directory, wtDir, id)
    await releaseWorktreeAt($, log, directory, wtPath, branch)
  } catch (err) {
    await log("info", `loop: worktree cleanup for ${id} skipped — ${(err as Error).message}`)
  }
}

/**
 * Remove one specific worktree directory — the path-addressed sibling of
 * `releaseWorktree`, for loops whose branch the config does not name (a sitter
 * kind isolating onto a PR's own head branch, a free-text goal). Same
 * guarantees: never the main tree, never `--force`, best-effort and never
 * throws.
 */
export const releaseWorktreeAt = async (
  $: Shell,
  log: Log,
  directory: string,
  wtPath: string,
  branch: string,
): Promise<void> => {
  try {
    if (path.resolve(wtPath) === path.resolve(directory)) return
    if (!(await isGitRepo($, wtPath))) {
      await pruneWorktrees($, directory)
      return
    }
    if (!(await removeWorktree($, directory, wtPath))) {
      await log("info", `loop: worktree ${wtPath} left in place (dirty or locked) — branch ${branch} holds the work`)
      return
    }
    await pruneWorktrees($, directory)
  } catch (err) {
    await log("info", `loop: worktree cleanup at ${wtPath} skipped — ${(err as Error).message}`)
  }
}
