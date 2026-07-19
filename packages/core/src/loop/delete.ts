import path from "node:path"
import type { Task } from "../task/schema.js"
import { listByStatus, listClaimIds, releaseClaim, STATUSES } from "../task/store.js"
import type { TaskStatus } from "../task/statuses.js"
import { commitRemovals, deleteBranch, isDirty, isGitRepo, removeWorktree, pruneWorktrees, unmergedCommitCount } from "./git.js"
import { findAnyStatus, resolveGateId, type GateCtx, type GateResult } from "./gate.js"
import { taskWorktreePath } from "./isolate.js"

/**
 * `delete <id>` — the one destructive verb: hard-removes a task's file, its git
 * worktree, and its `feature/<id>` branch together.
 *
 * Deliberately NOT in `gate.ts`. Every gate op is a lifecycle *advance* obeying
 * `canTransition`; there is no delete edge, and `moveTask` would refuse one.
 * Retiring a task without destroying it is still `moveTask(..., "abandoned")` —
 * this is for a task that should never have existed.
 *
 * The safety contract: **nothing that exists only here is destroyed unless the
 * caller passed `force`.** Four independent layers enforce it —
 * `unmergedCommitCount` decides the refusal, `git branch -d` applies git's own
 * merge check on the non-force path, an on-disk claim marker blocks the delete
 * regardless of `force`, and an epic refuses its whole cascade until a second,
 * forced call.
 *
 * Note what `force` does and does not buy: for a single task it is a one-step
 * override, so a caller that passes it on the FIRST call destroys the work
 * without having been shown a refusal. That is intended for a human who already
 * knows — the two-step "see it, then confirm it" flow is enforced only for an
 * epic (where one command destroys N tasks) and offered by the hub for
 * everything via its preview endpoint.
 *
 * Known gap (accepted, not solved): the epic roster is re-surveyed on the forced
 * call, so a child that gained its `Part of epic:` marker between the preview
 * and the confirm is deleted without having been listed. Closing it needs a
 * roster digest threaded through both calls; until then the success message
 * enumerates everything actually deleted, so the divergence is at least visible
 * after the fact.
 */

/**
 * The body marker `loop-plan-author` writes on each child of a slice set.
 *
 * The lookahead must be `(?=\s|$)`, NOT `\b`: `\b` treats `-` and `.` as word
 * boundaries, so epic `a1b2-auth` would match `Part of epic: a1b2-auth-v2` and
 * cascade into a DIFFERENT epic's children — destroying their branches.
 */
const epicChildMarker = (epicId: string): RegExp =>
  new RegExp(`^Part of epic:\\s*${epicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "m")

/** What deleting one task would destroy. Computed entirely from reads. */
export interface DeletionSurvey {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly taskPath: string
  /** This task's registered worktree, or null. Never the main tree. */
  readonly worktree: string | null
  readonly worktreeDirty: boolean
  readonly branch: string
  readonly branchExists: boolean
  /** Commits reachable from nowhere else; `null` = undeterminable ⇒ treated as unsafe. */
  readonly unmergedCommits: number | null
  /** Child slices, when this is a tracking epic. Empty otherwise. */
  readonly children: readonly DeletionSurvey[]
  /** Non-empty ⇒ a bare `delete` refuses. Includes children's blockers. */
  readonly blockers: readonly string[]
  readonly isEpic: boolean
}

export interface DeleteOptions {
  readonly force?: boolean
}

/**
 * Split `delete`'s argument remainder. `id`, `id force`, `--force id`, and
 * `id --force` all parse the same. Pure.
 */
export const parseDeleteArgs = (rest: string): { id: string; force: boolean } => {
  const parts = rest.trim().split(/\s+/).filter(Boolean)
  // Bare `force` counts too — the hosts document `delete <id> force`, and the
  // dashed spellings are accepted so muscle memory from other CLIs still works.
  const isForce = (p: string): boolean => /^(--?)?force$/i.test(p)
  return { id: parts.find((p) => !isForce(p)) ?? "", force: parts.some(isForce) }
}

/** The status folder a located task sits in. */
const statusOfTask = (t: Task): TaskStatus => path.basename(path.dirname(t.path)) as TaskStatus

/** Survey one task — no recursion into children. */
const surveyOne = async (ctx: GateCtx, task: Task): Promise<DeletionSurvey> => {
  const { $, directory, config } = ctx
  const id = task.id
  const branch = `feature/${id}`
  const repo = await isGitRepo($, directory)

  const wtPath = repo ? await taskWorktreePath($, directory, config, id) : null
  // Only a worktree that actually exists on disk counts — a conventional path
  // for a task that never built is not a worktree.
  const worktree = wtPath && (await isGitRepo($, wtPath)) ? wtPath : null
  const worktreeDirty = worktree ? await isDirty($, worktree) : false

  const exists = repo ? await unmergedCommitCount($, directory, branch) : null
  // `unmergedCommitCount` returns null both for "no such branch" and for a
  // genuine failure. Disambiguate: a branch that doesn't exist blocks nothing.
  const branchPresent = repo ? await branchIsPresent(ctx, branch) : false
  const unmergedCommits = branchPresent ? exists : 0

  const blockers: string[] = []
  if (worktreeDirty) blockers.push(`its worktree ${worktree} has uncommitted changes`)
  if (branchPresent && unmergedCommits === null) {
    blockers.push(`could not determine whether ${branch} has unmerged commits`)
  } else if (branchPresent && (unmergedCommits ?? 0) > 0) {
    blockers.push(`${branch} has ${unmergedCommits} commit(s) that exist nowhere else`)
  }

  return {
    id,
    title: task.title,
    status: statusOfTask(task),
    taskPath: task.path,
    worktree,
    worktreeDirty,
    branch,
    branchExists: branchPresent,
    unmergedCommits,
    children: [],
    blockers,
    isEpic: task.type === "epic",
  }
}

/**
 * Whether task `id` is being driven right now, from the union of two signals:
 *
 * 1. The **on-disk claim marker** in its status folder's `.claims/` — the only
 *    cross-process signal there is.
 * 2. The host's `isDriving` callback, when supplied.
 *
 * Reading the marker here rather than trusting `ctx.isDriving` alone is
 * deliberate. Both CLI hosts answer `isDriving` from their OWN process (an
 * in-memory session map; a single `active` loop), so a task driven by a `watch`
 * worker in another process looks idle to a second session — and deleting it
 * would rip the worktree out from under a live BUILD. `GateCtx.isDriving` is
 * also optional, so an unwired host would otherwise get no guard at all.
 *
 * Biased toward "driving" when unsure, matching the hub's driving oracle. A
 * genuinely stale marker is cleared by `doctor fix`, which the refusal names.
 */
const isBeingDriven = async (ctx: GateCtx, id: string, status: TaskStatus): Promise<boolean> => {
  if (ctx.isDriving?.(id) === true) return true
  const held = await listClaimIds(ctx.$, ctx.directory, ctx.config.tasksDir, status)
  return held.includes(id)
}

const branchIsPresent = async (ctx: GateCtx, branch: string): Promise<boolean> => {
  const { $, directory } = ctx
  const out = await $`git -C ${directory} rev-parse --verify --quiet ${`refs/heads/${branch}`}`.quiet().nothrow()
  return out.exitCode === 0
}

/**
 * Every task whose body marks it as a child of `epicId`. Read from the
 * CHILD's own file rather than the epic's body list: a child states its own
 * parentage, which survives the epic body being reflowed or hand-edited.
 *
 * Known gap (surfaced in the preview, not silently swallowed): a child whose
 * marker was edited away is invisible here and will be left behind.
 */
const findEpicChildren = async (ctx: GateCtx, epicId: string): Promise<Task[]> => {
  const { client, directory, config, log } = ctx
  const re = epicChildMarker(epicId)
  const found: Task[] = []
  for (const s of STATUSES) {
    for (const t of await listByStatus(client, directory, config.tasksDir, s, log)) {
      if (t.id !== epicId && re.test(t.body)) found.push(t)
    }
  }
  return found
}

/**
 * Read-only preview of what deleting `id` would destroy, including an epic's
 * child slices. Mutates nothing — hosts render this for confirmation.
 */
export const surveyDeletion = async (
  ctx: GateCtx,
  id: string,
): Promise<{ survey: DeletionSurvey } | { error: GateResult }> => {
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return { error: resolved.error }
  if (resolved) id = resolved.id

  const task = await findAnyStatus(ctx, id)
  if (!task) return { error: { ok: false, message: `No task "${id}".`, variant: "warning" } }

  const base = await surveyOne(ctx, task)
  if (!base.isEpic) return { survey: base }

  const children = await Promise.all((await findEpicChildren(ctx, id)).map((c) => surveyOne(ctx, c)))
  return {
    survey: {
      ...base,
      children,
      // A single blocked child blocks the whole cascade: a partial cascade
      // would leave orphans no longer reachable from any epic.
      blockers: [...base.blockers, ...children.flatMap((c) => c.blockers.map((b) => `${c.id}: ${b}`))],
    },
  }
}

/** One line per surveyed item, for a refusal/preview message. */
const describe = (s: DeletionSurvey): string => {
  const bits = [s.worktree ? "worktree" : null, s.branchExists ? s.branch : null].filter(Boolean)
  return `${s.id} (${s.status}${bits.length ? `, ${bits.join(" + ")}` : ", no worktree or branch"})`
}

/**
 * Destroy one surveyed task's git artifacts, then its file.
 *
 * Ordering is load-bearing and asymmetric:
 * - Worktree removal failing **aborts before the file is touched** — a
 *   half-delete (file gone, worktree orphaned) is worse than a clean refusal.
 * - Branch deletion failing is **non-fatal**: a surviving branch destroys
 *   nothing, so it is reported rather than escalated.
 */
const destroyOne = async (
  ctx: GateCtx,
  s: DeletionSurvey,
  force: boolean,
): Promise<{ ok: true; branchDeleted: boolean; staged: boolean } | { ok: false; message: string }> => {
  const { $, directory, log } = ctx
  const repo = await isGitRepo($, directory)

  if (s.worktree) {
    if (!(await removeWorktree($, directory, s.worktree, { force }))) {
      return {
        ok: false,
        message: `its worktree ${s.worktree} could not be removed (locked, or in use). Resolve it — \`git worktree unlock\` / close anything using it — then retry.`,
      }
    }
    await pruneWorktrees($, directory)
  }

  const branchDeleted = s.branchExists ? await deleteBranch($, directory, s.branch, { force }) : true

  // `git rm` succeeding means the file was TRACKED and its deletion is now
  // staged — which is what decides whether a commit is owed for it below.
  let staged = repo && (await gitRm(ctx, s.taskPath, false))
  if (!staged) staged = repo && (await gitRm(ctx, s.taskPath, true))
  if (!staged) await $`rm -f ${s.taskPath}`.quiet().nothrow()

  const still = await $`test -e ${s.taskPath}`.quiet().nothrow()
  if (still.exitCode === 0) {
    return { ok: false, message: `its git artifacts were removed but the file ${s.taskPath} survived — remove it by hand.` }
  }

  // Released only once the file is confirmed gone. Releasing earlier would, on
  // a failed removal, leave a claimable task whose worktree and branch are
  // already destroyed — a watcher would pick it up and build into nothing.
  await releaseClaim($, { id: s.id, path: s.taskPath })

  if (!branchDeleted) {
    await log("info", `delete: branch ${s.branch} survives — it is checked out somewhere, or git refused it`)
  }
  return { ok: true, branchDeleted, staged }
}

const gitRm = async (ctx: GateCtx, file: string, force: boolean): Promise<boolean> => {
  const args = force ? ["rm", "--quiet", "-f", "--", file] : ["rm", "--quiet", "--", file]
  const out = await ctx.$`git -C ${ctx.directory} ${args}`.quiet().nothrow()
  return out.exitCode === 0
}

/**
 * Hard-delete task `id`: its worktree, its `feature/<id>` branch, and its file
 * (`git rm` + commit). Refuses when that would discard work, unless `force`.
 *
 * A tracking epic cascades to every child slice, and **always** requires the
 * two-step flow: a bare call returns the roster it would destroy and deletes
 * nothing, so `force` is never the first thing a human types at an epic.
 */
export const deleteTask = async (ctx: GateCtx, id: string, opts: DeleteOptions = {}): Promise<GateResult> => {
  const { $, directory } = ctx
  const force = opts.force === true

  const surveyed = await surveyDeletion(ctx, id)
  if ("error" in surveyed) return surveyed.error
  const survey = surveyed.survey

  // A live loop's task is never deleted — `force` does NOT override this. The
  // run would keep writing into a worktree we just removed.
  const targets = [...survey.children, survey]
  for (const t of targets) {
    if (await isBeingDriven(ctx, t.id, t.status)) {
      const which = t.id === survey.id ? `"${t.id}"` : `its child "${t.id}"`
      return {
        ok: false,
        message:
          `Can't delete ${which}: a loop is driving it right now (it holds a claim) — stop that loop first. ` +
          `If you're sure nothing is running, the claim is stale: clear it with doctor fix, then retry.`,
        variant: "warning",
      }
    }
  }

  // An epic never deletes on the first call, blockers or not: one command
  // destroying N tasks deserves a roster the human has actually seen.
  if (survey.isEpic && !force) {
    const roster = [survey, ...survey.children].map((s) => `  · ${describe(s)}`).join("\n")
    const blocked = survey.blockers.length ? `\n\nBlocked by:\n${survey.blockers.map((b) => `  · ${b}`).join("\n")}` : ""
    return {
      ok: false,
      message:
        `"${survey.title}" is a tracking epic — deleting it also deletes ${survey.children.length} child slice(s). ` +
        `This would delete:\n${roster}${blocked}\n\nNothing has been deleted. Re-run with \`force\` to delete all ${survey.children.length + 1}.`,
      variant: "warning",
    }
  }

  if (!force && survey.blockers.length) {
    return {
      ok: false,
      message:
        `Can't delete "${survey.title}": ${survey.blockers.join(", and ")}. ` +
        `This would discard work — inspect it first, or re-run with \`force\` to delete anyway.`,
      variant: "warning",
    }
  }

  // Children first, epic last: a mid-cascade failure leaves the epic behind as
  // the record of what was being deleted, never orphaned children.
  const deleted: string[] = []
  const removedPaths: string[] = []
  const survivingBranches: string[] = []
  for (const t of targets) {
    const r = await destroyOne(ctx, t, force)
    if (!r.ok) {
      // Commit whatever already went, so a mid-cascade failure never leaves
      // deletions staged-but-uncommitted in the human's index.
      const committed = await commitRemovals($, directory, removedPaths, `loop: deleted ${deleted.join(", ")}`)
      // NEVER claim "nothing was deleted" without checking: in a cascade,
      // earlier targets are already gone for good, and saying otherwise sends
      // the human looking for tasks that no longer exist.
      const already = deleted.length
        ? ` ${deleted.length} task(s) were already deleted and ${committed ? "committed" : "removed"}: ${deleted.join(", ")}.`
        : " Nothing was deleted."
      return { ok: false, message: `Can't delete "${t.id}": ${r.message}${already}`, variant: "warning" }
    }
    deleted.push(t.id)
    if (r.staged) removedPaths.push(t.taskPath)
    if (!r.branchDeleted && t.branchExists) survivingBranches.push(t.branch)
  }

  // `removedPaths` holds only files `git rm` actually staged, so an empty list
  // means nothing was tracked — genuinely nothing to commit, not a failure.
  const committed = removedPaths.length === 0 || (await commitRemovals($, directory, removedPaths, `loop: deleted ${deleted.join(", ")} — worktree and branch removed`))

  const n = deleted.length
  const head = survey.isEpic ? `Deleted epic "${survey.title}" and ${n - 1} child slice(s).` : `Deleted "${survey.title}".`
  const kept = survivingBranches.length ? ` Branch(es) ${survivingBranches.join(", ")} survive — checked out elsewhere; delete by hand.` : ""
  const remote = " Any pushed `origin/` branch is untouched."

  /*
   * A failed commit is NOT cosmetic and must not be reported as success. The
   * files are gone from disk and their deletion is staged in the human's index;
   * silently returning ok would let their next unrelated `git commit` sweep it
   * up. Common causes: a pre-commit hook that exits non-zero, gpgsign with no
   * agent, or a rebase in progress.
   */
  if (!committed) {
    return {
      ok: false,
      message:
        `Deleted ${deleted.join(", ")} (worktree and branch removed), but the commit failed — ` +
        `the deletion is STAGED in your index, not committed. Finish it with \`git commit\`, or run \`git reset\` to unstage. ` +
        `A pre-commit hook, commit signing, or an in-progress rebase is the usual cause.`,
      variant: "warning",
    }
  }

  return {
    ok: true,
    message: `${head}${kept}${remote}`,
    path: survey.taskPath,
    data: { deleted, forced: force, survivingBranches, epic: survey.isEpic },
  }
}
