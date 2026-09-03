import type { Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { resolveValidateHook } from "../manifest/registry.js"
import { appendNote, auditNote, contractRejectedNote, extractPlan, findByIdIn, moveTask, planHeadingCount, releaseClaim, RUN_DIFF_PREFIX, stopContextNote, unaddressedRejectionCount } from "../task/store.js"
import { redact } from "../task/redact.js"
import { clampedChecksDetail, previewDiscoveredChecks } from "./discovered-checks.js"
import { depsSummaryLine, previewDeclaredDeps } from "./declared-deps.js"
import { hasVerificationSection } from "./verdict.js"
import type { TaskStatus } from "../task/statuses.js"
import { diffShortstat, ensureExcluded } from "./git.js"
import { clearState } from "./persist.js"
import { workflowId, releaseCurrentBranchLock, releaseWorktreeAt, rivalHoldsCurrentBranchLock, teardownIsolation } from "./isolate.js"
import type { Action, AttemptRecord, Config, WorkflowState } from "./state.js"
import type { Outcome } from "./metrics.js"

/**
 * The terminal bookkeeping shared by both hosts — what happens when a loop's
 * pure state machine yields a `park`, `done`, or `stop` action. Previously
 * hand-ported between the OpenCode driver's `drive` switch (which toasted) and
 * the Claude MCP server's `runPark`/`runTerminal` (which returned MCP
 * descriptors), the two copies had drifted: the Claude host never ran the
 * manifest's `validateBeforeTransition` veto, and the isolated-gating that keeps
 * a never-isolated stage (pr-sitter `triage` → done) from mutating the human's
 * main tree lived independently in each. This is the single source: it performs
 * the audited move + backlog commit + metrics + isolation teardown, gating every
 * main-tree write on `state.isolated` (the B5 fix, centralized), and returns a
 * structured `TerminalReport` each host renders — the OpenCode driver toasts, the
 * Claude server serializes a gate/next descriptor. Sibling of `gate.ts`.
 *
 * Everything host-specific comes through `TerminalCtx` ports: `commitBacklog`
 * (the main-tree backlog commit strategy), `checkpoint` (the work-tree commit-all
 * strategy — called only when isolated), and `writeMetrics` (the run summary +
 * structured sidecar, which observe tokens/sessionID differently per host). The
 * control flow — veto, plan-landed check, task move, ordering, isolated-gating —
 * is shared here.
 *
 * Ordering invariant: on done/stop the work-tree checkpoint + isolation teardown
 * run BEFORE any backlog write. In shared-tree mode the main tree sits on
 * `feature/<id>` until teardown, so a task move or note made earlier would be
 * committed onto the loop branch and vanish from the human branch at the teardown
 * checkout — the loop reports "done" while the human's backlog still shows the
 * task in in-progress/, and the ship gate can't find it.
 */

export interface TerminalCtx {
  readonly $: Shell
  readonly log: Log
  readonly directory: string
  readonly config: Config
  /** The loop state reaching the terminal event. */
  readonly state: WorkflowState
  /** The claimed kind's manifest — its `validateBeforeTransition` veto runs here. */
  readonly manifest: LoadedManifest
  /** git identity for audit notes (resolved once by the host; null outside a repo). */
  readonly actor: string | null
  /**
   * Commit the backlog (tasksDir) on the MAIN tree — the host's strategy
   * (OpenCode serializes via its per-tree commit lock; Claude calls commitPaths).
   * Core decides WHEN to call it: on every park, done-move, and stop note —
   * always after the work-tree checkpoint + teardown, so in shared-tree mode
   * the commit lands on the human branch, never on the loop branch.
   */
  readonly commitBacklog: (message: string) => Promise<void>
  /**
   * Commit everything on the loop's work tree as a checkpoint — the host's
   * strategy (OpenCode wraps commitAll in its commit lock; Claude calls commitAll
   * on its work tree). Called by core ONLY when `state.isolated`.
   */
  readonly checkpoint: (message: string) => Promise<void>
  /**
   * Render this run's summary into the run log and write the structured metrics
   * sidecar — the host's strategy (the accumulated samples, the observing host
   * label, and the driving sessionID all differ per host).
   */
  readonly writeMetrics: (outcome: Outcome, detail: string, retryable?: boolean) => Promise<void>
}

/**
 * The structured outcome of terminal handling, mirroring `gate.ts`'s
 * `GateResult`. Each host maps it to its own presentation:
 * - `park`      — PLAN wrote a plan; the task parked in plan-review/ for the human gate.
 * - `park-free` — a free-text (task-less) plan park; nothing moved.
 * - `error`     — the park was vetoed, or PLAN wrote no plan; the task stays put.
 * - `done`      — the loop finished; the task parked in in-review/ (`moved`) for diff review.
 * - `stop`      — the loop stopped incomplete; partial work preserved on `branch`.
 */
export type TerminalReport =
  | { readonly kind: "park"; readonly taskId: string; readonly path: string; readonly message: string }
  | { readonly kind: "park-free"; readonly message: string }
  | { readonly kind: "error"; readonly message: string; readonly taskId?: string }
  | {
      readonly kind: "done"
      readonly message: string
      readonly taskId?: string
      readonly moved: boolean
      readonly branch?: string
      /** One-line `git diff --shortstat` of the run's work — what the diff review is signing up for. Absent when it could not be computed. */
      readonly diffstat?: string
      /** The exact command that shows the reviewed range (`git diff <base>...<branch>`), for the host to hand the human verbatim. */
      readonly diffCmd?: string
      /** The final check stage's non-blocking findings, for the human at the diff review (see `Action`'s done arm). */
      readonly suggestions?: readonly string[]
    }
  | { readonly kind: "stop"; readonly message: string; readonly taskId?: string; readonly branch?: string; readonly retryable?: boolean }

/**
 * Checkpoint the work tree and tear the isolation down — but ONLY when the loop
 * actually isolated. A source-pre-set `git` (naming the branch to isolate ONTO)
 * without `isolated` must NOT reach here: `checkpoint` would `git add -A && commit`
 * the human's main tree and `teardownIsolation` would check out the base branch on
 * it (the centralized B5 fix — both hosts route through this). Runs FIRST on
 * done/stop, before any backlog write — see the module doc's ordering invariant.
 */
const closeIsolation = async (ctx: TerminalCtx, checkpointMessage: string): Promise<void> => {
  try {
    await closeIsolationOrThrow(ctx, checkpointMessage)
  } catch (err) {
    // Never fail a drive's END over its tree cleanup. This runs FIRST on
    // done/stop, so a throw here used to skip everything after it — the audit
    // note, the move, the claim release, the metrics — and the claim then sat
    // held until the stale sweep. The work is not lost either way (it stays in
    // the tree, uncommitted); what a throw cost was the bookkeeping that ends
    // the run. Warn loudly and let the terminal path finish.
    await ctx.log("warn", `loop: end-of-run tree cleanup failed (${(err as Error).message}) — this run's uncommitted work stays in the tree; the task's move and claim release continue`)
  }
}

const closeIsolationOrThrow = async (ctx: TerminalCtx, checkpointMessage: string): Promise<void> => {
  const { $, directory, config, state, log } = ctx
  // Current-branch mode shares the human's tree, so the ordinary gate is not
  // enough at a drive's END — no stage boundary's re-hold runs in front of this:
  //  - a RIVAL may hold the lock now (this run's went stale mid-phase and was
  //    swept): checkpointing would `git add -A` the rival's in-flight work into
  //    this run's commit, and the release would free the rival's live lock. Skip
  //    both — the rival's own end owns the tree's cleanup now.
  //  - a run that DEGRADED (`isolated: false` — the tree moved) still holds the
  //    lock from its last good boundary. It must not checkpoint, but the lock
  //    must not outlive the drive either, or the tree refuses every later run
  //    until the stale sweep, with a refusal naming a run that already ended.
  if (state.git?.onCurrentBranch) {
    if (await rivalHoldsCurrentBranchLock($, directory, config, state)) {
      await log("warn", "loop: this tree's current-branch lock is held by another run now — skipping the end-of-run checkpoint; this run's uncommitted work stays in the tree")
      return
    }
    if (!state.isolated) {
      await releaseCurrentBranchLock($, log, directory, config, workflowId(state))
      return
    }
    await ctx.checkpoint(checkpointMessage)
    await teardownIsolation($, log, directory, config, state)
    return
  }
  if (!state.isolated) return
  await ctx.checkpoint(checkpointMessage)
  await teardownIsolation($, log, directory, config, state)
}

/**
 * Commit the backlog via the host's strategy, unless `config.ignoreBacklog`
 * (the default) says to leave it alone — then just re-assert the
 * `.git/info/exclude` entry instead of touching either host's commit path.
 */
const commitBacklog = async (ctx: TerminalCtx, message: string): Promise<void> => {
  if (ctx.config.ignoreBacklog) {
    await ensureExcluded(ctx.$, ctx.directory, ctx.config.tasksDir)
    return
  }
  await ctx.commitBacklog(message)
}

/**
 * Consecutive contract refusals (rejection notes with no successful park
 * between them) before the park gate stops re-queueing and returns the task to
 * draft/ for human triage. Derived from the audit tail, never stored — the
 * task file IS the ledger, so the count is crash-safe by construction.
 */
const CONTRACT_REFUSAL_LIMIT = 3

/**
 * The park gate's two refusal reasons, exported as consts so the hub's metrics
 * aggregate can count contract refusals by matching sidecar `detail` against
 * the exact strings the writer used — a hand-copied string there is how the
 * two drift and the count silently reads zero forever.
 */
export const PARK_NO_PLAN_WHY = "the PLAN stage wrote no ## Implementation Plan"
export const PARK_NO_VERIFICATION_WHY =
  "the plan has no ### Verification subsection — the plan contract requires one mapping each acceptance criterion to its proof"

/** park: PLAN finished — validate the plan landed, move the task to plan-review/, or veto. */
const runPark = async (ctx: TerminalCtx, action: Extract<Action, { kind: "park" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  // A manifest may name a pre-transition validator for this stage
  // (`hooks.validateBeforeTransition`); a registered hook returning a reason vetoes
  // the park. Resolving it HERE fixes the drift where only the OpenCode host honored
  // it. Engineering's plan-landed check is done explicitly below (its ref is a
  // registered pass-through); an unregistered ref throws — dangling refs fail loudly.
  const validate = resolveValidateHook(ctx.manifest.manifest.hooks.validateBeforeTransition[state.stage])
  const veto = validate ? await validate(state) : null
  if (veto) {
    await log("warn", `loop: ${state.stage} park vetoed by validator — ${veto}`)
    if (state.task) {
      // Drive-end path like every arm below: the release is unconditional,
      // falling back to the claim-time ref when the task left queued/
      // mid-plan — nesting it under the lookup wedged the claim (see the
      // not-parking arm's comment).
      const held = await findByIdIn($, directory, config.tasksDir, "queued", state.task.id)
      await releaseClaim($, held ?? state.task, log)
    }
    await ctx.writeMetrics("error", veto)
    return { kind: "error", message: `Park vetoed for "${state.task?.id ?? state.goal}" — ${veto}`, ...(state.task ? { taskId: state.task.id } : {}) }
  }
  // A free-text (task-less) loop has nothing to park onto — nothing moves.
  if (!state.task) return { kind: "park-free", message: action.message }
  const id = state.task.id
  // Validate the plan actually landed on disk before parking — a PLAN stage that
  // wrote nothing must not put a planless task in front of the human gate.
  const fresh = await findByIdIn($, directory, config.tasksDir, "queued", id)
  // `extractPlan` is the same predicate the plan-approval gate and `isClaimable`
  // run (`hasPlan` is defined AS its truthiness) — the contract check runs on its
  // output, never on the raw body, so the two gates cannot disagree about what a
  // plan is. The Verification-heading veto reuses THIS failure arm rather than
  // adding one: the arm already carries the delicate parts (note only when
  // `fresh` exists, the UNCONDITIONAL claim release below, metrics), and every
  // new exit path from a drive must release the marker.
  const plan = fresh ? extractPlan(fresh) : undefined
  // Tolerant lookup, not `stageDef` — that throws on an unknown stage, and a
  // park landing here must always reach the claim release below, never crash
  // out of runTerminal on a manifest/state mismatch. Missing def ⇒ no contract.
  const wantsContract = ctx.manifest.manifest.stages?.find((s) => s.name === state.stage)?.planContract === true
  const missingVerification = Boolean(plan) && wantsContract && !hasVerificationSection(plan ?? "")
  if (!fresh || !plan || missingVerification) {
    const why = !fresh ? "the task left queued/ mid-plan" : !plan ? PARK_NO_PLAN_WHY : PARK_NO_VERIFICATION_WHY
    await log("warn", `loop(${id}): not parking — ${why}`)
    if (fresh) {
      // The refusal is recorded as a CANONICAL rejection note (`contractRejectedNote`
      // — the same shape `planRejectedNote` gives a human `replan`, so
      // `extractReplanReason` still threads it into the next PLAN pass's
      // {{#replan}} section, but TAGGED so `unaddressedRejectionCount` counts
      // it separately from a human's deliberate rejection — see its doc. The
      // old free-form "PLAN stage failed" note matched nothing, and the retry
      // re-planned blind to the refusal — repeating the same contract mistake
      // every poll tick. The note only makes sense on a file that is still
      // there — appending to a stale path would `>>`-recreate a moved task as
      // a frontmatterless ghost.
      await appendNote($, fresh, auditNote(contractRejectedNote(why), new Date(), actor), log)
      // Three rejections with no successful park between them mean the planner
      // is looping on the same refusal — each poll tick burns a full PLAN run
      // and appends another note, forever, because the queued pool re-claims
      // immediately. Stop-for-human: return the task to draft/ (out of every
      // claim walk) with a triage note. `+ 1` counts the note just appended,
      // which `fresh.body` (read before it) does not carry.
      const refusals = unaddressedRejectionCount(fresh.body) + 1
      if (refusals >= CONTRACT_REFUSAL_LIMIT) {
        // The try spans ONLY the note and the move: once the move has landed,
        // the task IS in draft/, and a later failure (a commit hiccup) must not
        // fall into the stay-queued arm — that arm logs and reports "It stays
        // in queued/", the one place the task no longer is.
        let newPath: string | null = null
        try {
          await appendNote($, fresh, auditNote(`Plan contract unmet after ${refusals} attempts — returned to draft for human triage`, new Date(), actor), log)
          newPath = await moveTask($, fresh, "draft" as TaskStatus) // also releases the queued/ claim marker
        } catch (err) {
          // A failed draft return falls through to the stay-queued arm below —
          // which still releases the claim, the invariant every exit path keeps.
          await log("warn", `loop(${id}): draft return failed (${(err as Error).message}) — staying queued`)
        }
        if (newPath) {
          try {
            await commitBacklog(ctx, `loop(${id}): plan contract unmet ${refusals}× — returned to draft`)
          } catch (err) {
            await log("warn", `loop(${id}): draft return landed but the backlog commit failed (${(err as Error).message}) — the move is on disk, uncommitted`)
          }
          await ctx.writeMetrics("error", `${why} — returned to draft after ${refusals} refusals`)
          return {
            kind: "error",
            message: `PLAN failed for "${id}" ${refusals} times — ${why}. Returned to ${newPath} for human triage.`,
            taskId: id,
          }
        }
      }
    }
    // The RELEASE, though, is unconditional: this ends the drive, and every way a
    // drive ends must release the marker. When the task left queued/ mid-plan
    // `fresh` is null, and nesting the release under it wedged the queued/ claim
    // forever — a held marker means "a loop is driving this NOW", so every gate
    // verb (replan/abandon/remove) refuses on it and neither `plan <id>` nor the
    // claim walk could re-acquire it until the ~75m stale sweep fired. Fall back
    // to the claim-time ref exactly as `runStop` does.
    await releaseClaim($, fresh ?? state.task, log)
    await ctx.writeMetrics("error", why)
    return { kind: "error", message: `PLAN failed for "${id}" — ${why}. It stays in queued/.`, taskId: id }
  }
  // The stage prompt tells PLAN to REPLACE an existing `## Implementation Plan`
  // rather than stack a second one — the shape a replanned task invites, since
  // `replanTask` re-queues the file with its old plan intact. Prose alone is not
  // a mechanism, so say so when it was not honoured. Warn, never veto: the park
  // is otherwise valid (`extractPlan` reads the last heading, so the run has the
  // right plan), and vetoing would strand the task in queued/ with its claim
  // released and no verb that helps — strictly worse than a polluted body.
  const headings = planHeadingCount(fresh.body)
  if (headings > 1) {
    await log("warn", `loop(${id}): parking with ${headings} ## Implementation Plan headings — PLAN stacked instead of replacing; the superseded plan stays in the task's prose`)
  }
  // Preview what the consuming check stage will decide about the plan's
  // agentic-checks fence AT THE GATE the human is about to read, instead of at
  // fire time where the same refusals go to a log line nobody watches — a plan
  // whose whole block is inadmissible used to park clean, get approved, and
  // silently run a VERIFY with zero checks. Forecast only (no binary probe —
  // see `previewDiscoveredChecks`), never a veto: design 18 makes the block
  // optional and the allowlist, not this gate, the boundary. The suffix rides
  // AFTER the `Plan written` marker prefix, so the retirement anchors that
  // parse that line are untouched.
  const preview = previewDiscoveredChecks(ctx.manifest.manifest, config, plan)
  let checksLine = ""
  if (preview) {
    for (const issue of preview.issues) await log("warn", `loop(${id}): ${issue}`)
    const clipped = clampedChecksDetail(preview.issues)
    checksLine =
      preview.admitted > 0
        ? ` — discovered checks: ${preview.admitted} admitted for ${preview.consumer.toUpperCase()}${preview.issues.length ? `; ${preview.issues.length} dropped (${clipped})` : ""}`
        : preview.fencePresent
          ? ` — discovered checks: NONE admitted for ${preview.consumer.toUpperCase()} (${clipped || "the block admitted no commands"})`
          : ` — no agentic-checks block: ${preview.consumer.toUpperCase()} will run no machine-run checks`
  }
  // The same forecast one noun over: what the plan says it will INSTALL. A
  // dependency the plan author could not prove — the common shape on a repo
  // pointed at an internal mirror, where the author has no shell and no network
  // — is otherwise indistinguishable at this gate from a proven one, and the
  // loop only learns the difference when BUILD's install fails, an iteration
  // later. Named entries rather than a count, because the whole value is that
  // the answer fits on the line the human is already reading. Never a veto, and
  // `null` (no fence at all, i.e. most tasks) renders nothing rather than a line
  // on every park that would train the reader to skip this suffix entirely.
  //
  // Wrapped because this whole forecast is a nicety and the park is not: every
  // exit path from here has to reach `releaseClaim`, and a held marker asserts
  // a LIVE loop that every gate verb then refuses to act on. `resolveStageChecks`
  // states the same rule for its own module — a bug in it must never be the
  // thing that stops a run. A throw here costs the suffix and nothing else.
  let depsLine = ""
  try {
    const depsPreview = previewDeclaredDeps(plan)
    for (const issue of depsPreview?.issues ?? []) await log("warn", `loop(${id}): ${issue}`)
    depsLine = depsSummaryLine(depsPreview)
  } catch (err) {
    await log("warn", `loop(${id}): dependency forecast skipped — ${(err as Error).message}`)
  }
  await appendNote($, fresh, auditNote(`Plan written — parked for plan review${checksLine}${depsLine}`, new Date(), actor), log)
  // moveTask THROWS on a duplicate destination or a failed `mv`. Unguarded, that
  // exception escapes runTerminal after the park note is already on disk claiming
  // a park that never happened, and the queued/ claim marker is never released —
  // and a held marker blocks every gate verb until the stale sweep frees it.
  // Same guard runDone uses below, for the same reason.
  let newPath: string
  try {
    newPath = await moveTask($, fresh, (action.toStatus ?? "plan-review") as TaskStatus) // also releases the queued/ claim marker
  } catch (err) {
    const why = (err as Error).message
    await log("warn", `loop(${id}): plan written but park move failed: ${why}`)
    await appendNote($, fresh, auditNote(`Park failed — ${why}; still queued`, new Date(), actor), log)
    await releaseClaim($, fresh, log)
    await ctx.writeMetrics("error", why)
    return { kind: "error", message: `Plan written for "${id}" but the park to plan-review/ failed — ${why}. It stays in queued/.`, taskId: id }
  }
  await commitBacklog(ctx, `loop(${id}): plan written — parked for review`)
  await ctx.writeMetrics("done", "plan parked for review")
  // Both forecasts ride the report too: the park message is what the hosts
  // surface (toast / tool result), and the human deciding approve-or-replan
  // should not have to open the task file to learn that no checks will run, or
  // that the plan rests on a package nobody could prove this repo can install.
  return { kind: "park", taskId: id, path: newPath, message: `${action.message}${checksLine}${depsLine}` }
}

/** The most a suggestions audit note may carry. Same spirit as `STOP_DIGEST_MAX`:
 *  bounded by construction (the engine caps the list), clamped anyway — one line
 *  in a file humans read, and the engine's cap is not this module's to assume. */
const SUGGESTIONS_NOTE_MAX = 800

/** done: the loop finished — park the task in in-review/ for human diff review. */
const runDone = async (ctx: TerminalCtx, action: Extract<Action, { kind: "done" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  // Checkpoint FIRST, so the run's own work is committed before the backlog
  // note/move/commit below — otherwise the checkpoint's `git add -A` sweeps the
  // backlog write into the feature commit. (Teardown no longer moves a shared
  // tree off its work branch, so the backlog write lands there; with the default
  // `ignoreBacklog` nothing is committed at all.)
  await closeIsolation(ctx, `loop(${workflowId(state)}): done — review passed`)
  // A task-less loop (free-text goal, sitter kind) never reaches the ship gate —
  // the only other place a worktree is released — so a done here is its last
  // chance to reclaim the directory. The work is already checkpointed on the
  // branch; a stop keeps the worktree so `recover` can resume in it.
  if (!state.task && state.isolated && state.git?.worktree) {
    await releaseWorktreeAt($, log, directory, state.git.worktree, state.git.branch)
  }
  // The diff review's own numbers, computed while the run still knows its
  // range: the ship gate runs later from a fresh process, and the human
  // deciding whether to open the diff should not have to run git to learn its
  // size. Best-effort and by REF from the main checkout, so it works whether
  // the branch sits in a worktree, on this tree, or checked out nowhere.
  const diffstat = state.git ? await diffShortstat($, directory, state.git.base, state.git.branch) : null
  const diffCmd = state.git ? `git diff ${state.git.base}...${state.git.branch}` : null
  let moved = false
  let moveError: string | null = null
  if (state.task) {
    // Re-resolve the real current path (shell-authoritative) rather than trust the
    // claim-time state.task.path, which goes stale if the file moved since the claim.
    const cur = await findByIdIn($, directory, config.tasksDir, "in-progress", state.task.id)
    if (cur) {
      try {
        // Naming the branch is what lets the ship gate push the right one: it
        // runs from a fresh process long after `clearState` below dropped the
        // snapshot, and `extractRunBranch` reads it back off this line.
        //
        // The base rides the SAME line so branch and base pair up per run for
        // free — `extractRunBase` anchors on the same last-marker index — and it
        // goes after the branch's comma, which is what keeps `extractRunBranch`
        // (first comma wins) reading exactly what it read before.
        //
        // Only in the branch-cutting modes: `onCurrentBranch` makes `base` a
        // commit SHA (see `GitRef`), and `gh pr create --base <sha>` is not a
        // thing, so recording it would turn today's wrong-but-working platform
        // default into a hard ship failure.
        // The reviewer's non-blocking notes, surfaced where the human will
        // actually look (this file + the done report) rather than only in the
        // metrics sidecar. One line per the audit-note contract, redacted like
        // every model-authored text that lands on the task file, and appended
        // BEFORE the done note so that note stays the trail's newest line
        // (the hub's lastEvent reads the last note).
        if (action.suggestions?.length) {
          const flat = redact(action.suggestions.join("; ")).text.replace(/\s*\n\s*/g, " ")
          const clamped = flat.length > SUGGESTIONS_NOTE_MAX ? `${flat.slice(0, SUGGESTIONS_NOTE_MAX)}…` : flat
          await appendNote($, cur, auditNote(`Review suggestions (${action.suggestions.length}) — ${clamped}`, new Date(), actor), log)
        }
        const runBase = state.git && !state.git.onCurrentBranch ? `, base ${state.git.base}` : ""
        // The diff-stat clause goes LAST (see RUN_DIFF_PREFIX's doc for why its
        // commas cannot disturb the branch/base fields ahead of it).
        const runDiff = diffstat ? `${RUN_DIFF_PREFIX}${diffstat}` : ""
        const doneNote = state.git
          ? `Loop done — review passed on branch ${state.git.branch}${runBase}, awaiting human diff review${runDiff}`
          : "Loop done — review passed, awaiting human diff review"
        await appendNote($, cur, auditNote(doneNote, new Date(), actor), log)
        await moveTask($, cur, (action.toStatus ?? "in-review") as TaskStatus)
        await commitBacklog(ctx, `loop(${state.task.id}): done — parked in in-review`)
        moved = true
      } catch (err) {
        moveError = (err as Error).message
        await log("warn", `loop done but task move failed: ${moveError}`)
        // Correct the note, the way runPark and gate.ts's noteThenMove do: the
        // done note above is already on disk asserting a park that never
        // happened — and it names the branch, which is exactly the line the
        // ship gate's `extractRunBranch` reads back. Left standing alone, the
        // backlog claims a completed run for a task still in in-progress/.
        await appendNote($, cur, auditNote(`Park to in-review/ failed — ${moveError}; still in-progress`, new Date(), actor), log)
        // moveTask releases the claim only on success — release it here or the
        // marker wedges (the orphan sweep refuses bodies carrying a BUILD note,
        // and the body's BUILD note already blocks a redundant auto re-claim).
        await releaseClaim($, cur, log)
      }
    } else {
      moveError = `task ${state.task.id} is not in in-progress/`
      await log("warn", `loop done but task ${state.task.id} not in in-progress/ — not moved`)
      // Best-effort via the claim-time path — the marker lives in the folder
      // the claim was taken in, which state.task.path still locates.
      await releaseClaim($, state.task, log)
    }
  }
  if (state.task && moveError) {
    // Review passed but the park failed: reporting done would announce the ship
    // gate for a task still sitting in in-progress/, with metrics calling the
    // run clean. Surface a retryable stop instead (environment fault, not a
    // failed attempt) and KEEP the snapshot so `recover` can finish the park.
    await ctx.writeMetrics("error", `review passed but parking failed: ${moveError}`)
    return {
      kind: "stop",
      message: `✗ Review passed but parking in in-review/ failed: ${moveError} — the work is committed on the branch; fix the backlog, then recover the task.`,
      retryable: true,
      taskId: state.task.id,
      ...(state.git ? { branch: state.git.branch } : {}),
    }
  }
  await ctx.writeMetrics("done", "review passed")
  if (state.task) await clearState($, directory, config.tasksDir, state.task.id)
  return {
    kind: "done",
    message: action.message,
    moved,
    ...(state.task ? { taskId: state.task.id } : {}),
    ...(state.git ? { branch: state.git.branch } : {}),
    ...(diffstat ? { diffstat } : {}),
    ...(diffCmd ? { diffCmd } : {}),
    ...(action.suggestions?.length ? { suggestions: action.suggestions } : {}),
  }
}

/** The most a stop's attempts digest may carry onto its audit note. Bounded by
 *  construction already (the engine keeps the last 5 attempts at ≤200 reason
 *  chars each), but clamped anyway — the digest is one line in a file humans
 *  read, and the engine's constants are not this module's to assume. */
const STOP_DIGEST_MAX = 800

/**
 * One line per counted attempt — what the run tried and how each try ended.
 * This is the machine-recorded context a cap-stopped task otherwise loses at
 * `clearState`: `replanTask` fuses it into the rejection reason, so the next
 * PLAN pass plans against what kept failing instead of re-planning blind. Pure.
 */
const attemptsDigest = (attempts: readonly AttemptRecord[]): string => {
  const digest = attempts
    .map((a) => `iteration ${a.iteration + 1} ${a.stage.toUpperCase()} ${a.verdict}${a.reason ? `: ${a.reason}` : ""}`)
    .join("; ")
  return digest.length > STOP_DIGEST_MAX ? `${digest.slice(0, STOP_DIGEST_MAX)}…` : digest
}

/** stop: the loop stopped incomplete — annotate the task and preserve partial work. */
const runStop = async (ctx: TerminalCtx, action: Extract<Action, { kind: "stop" }>): Promise<TerminalReport> => {
  const { $, directory, config, state, actor, log } = ctx
  await closeIsolation(ctx, `loop(${workflowId(state)}): incomplete — ${action.message}`)
  if (state.task) {
    // Re-resolve the real current path (shell-authoritative) like runDone: the
    // claim-time state.task.path goes stale if the file moved since the claim, and
    // appendNote's `>>` would recreate a moved/deleted task file as a frontmatterless
    // ghost. Only PLAN runs out of queued/; every other stage runs out of in-progress/.
    const status: TaskStatus = state.stage === "plan" ? "queued" : "in-progress"
    const cur = await findByIdIn($, directory, config.tasksDir, status, state.task.id)
    if (cur) {
      await appendNote($, cur, auditNote(action.message, new Date(), actor), log)
      // A non-transient stop with attempts on the ledger (the iteration cap
      // above all) durably records WHAT each try failed on — the snapshot that
      // holds `state.attempts` is cleared a few lines down, and the replan the
      // cap message recommends reads only the task file. Gated on
      // `!retryable`: a flaky-environment stop's ledger is noise the next run
      // does not need. See `stopContextNote`/`extractStopContext` in store.ts.
      if (!action.retryable && state.attempts?.length) {
        await appendNote($, cur, auditNote(stopContextNote(attemptsDigest(state.attempts)), new Date(), actor), log)
      }
      // The loop is over — release the claim marker for EVERY stage, not just
      // PLAN. A held marker means "a loop may be driving this", and every gate
      // verb (replan/abandon/remove) refuses on it; releasing only the PLAN
      // case left a cap-stopped task permanently wedged: the cap message says
      // `replan <id>`, replan refused the held claim, and the orphan sweep
      // skips a body carrying CLAIMED/BUILD notes — no verb could ever free it.
      // For in-progress/ the watcher cannot silently re-claim after release: the
      // CLAIMED note in the lifecycle window keeps `isClaimable` false; only an
      // explicit `recover <id>` (which re-claims) or a gate verb touches it next.
      // A stopped PLAN is different by design — its queued/ task carries no such
      // note and that pool has no claim predicate, so the next claim/watch tick
      // may re-plan it. That is the intended behaviour, not a leak: PLAN writes
      // only the task file, so re-planning costs a pass and loses nothing.
      await releaseClaim($, cur, log)
      await commitBacklog(ctx, `loop(${state.task.id}): stopped — ${action.message}`)
    } else {
      // The file left its folder mid-run (human move/delete). Never write to the stale
      // path — but still release the claim marker best-effort: it lives in the
      // claim-time folder's .claims/, which state.task.path still locates.
      await releaseClaim($, state.task, log)
      await log("warn", `loop(${state.task.id}): stopped but task not in ${status}/ — stop note skipped`)
    }
  }
  // Thread the transient-vs-genuine distinction into the sidecar — on disk it
  // otherwise collapses to `outcome: "stopped"` and a dashboard can't tell a
  // flaky environment from cap exhaustion.
  await ctx.writeMetrics("stopped", action.message, action.retryable)
  if (state.task) await clearState($, directory, config.tasksDir, state.task.id)
  return { kind: "stop", message: action.message, ...(state.task ? { taskId: state.task.id } : {}), ...(state.git ? { branch: state.git.branch } : {}), ...(action.retryable ? { retryable: true } : {}) }
}

/**
 * Run the terminal bookkeeping for a park/done/stop action and return a structured
 * report. Callers gate on `action.kind` being terminal (a `noop`/`fire` should never
 * reach here); an unexpected kind is a defensive no-op reported as an error.
 */
/** Wall-clock cap on one `notifyCommand` invocation. */
export const NOTIFY_TIMEOUT_MS = 10_000

/** Longest AW_MESSAGE handed to the notifier — flattened to one line first. */
const NOTIFY_MESSAGE_MAX = 1000

/**
 * Fire the user's `notifyCommand` for a terminal report — the push that keeps
 * a gate from going stale in scrollback nobody is watching. One choke point
 * for every host and every kind, because both route their terminals through
 * `runTerminal` below.
 *
 * Best-effort and BOUNDED, in that order of importance: the notifier runs
 * after the terminal's own bookkeeping succeeded, a failure logs a warning
 * and changes nothing, and a hang is abandoned at `NOTIFY_TIMEOUT_MS` (the
 * spawned command may keep running detached — the loop will not wait on a
 * webhook). `park-free` fires nothing: a task-less free-text plan has no gate
 * to announce.
 *
 * The command runs as `sh -c <command>` under `env` with the event as
 * variables (`AW_EVENT`/`AW_KIND`/`AW_TASK`/`AW_MESSAGE`) — every value is an
 * escaped interpolation, so nothing from a task title or terminal message can
 * reach the shell as syntax.
 */
const notifyTerminal = async (ctx: TerminalCtx, report: TerminalReport): Promise<void> => {
  if (report.kind === "park-free") return
  const id = "taskId" in report ? (report.taskId ?? "") : ""
  await notifyLoopEvent(ctx, { event: report.kind, kind: ctx.state.kind ?? "engineering", taskId: id, message: report.message })
}

/** An event `notifyCommand` may announce: the four terminal ones, or a stage fire (design 54, opt-in). */
export type NotifyEvent = "park" | "done" | "stop" | "error" | "stage"

/**
 * Fire `notifyCommand` for one loop event — the choke point `notifyTerminal`
 * always was, exported so the hosts can announce a STAGE fire through the
 * same bounded, best-effort, escaped path (design 54). `stage` is opt-in: it
 * fires only when `notifyEvents` names it, where the terminal events fire by
 * default — a run pings four or more times per stage under it, and a notifier
 * wired for "the gate is waiting" must not start buzzing per stage unasked.
 */
export const notifyLoopEvent = async (
  ctx: Pick<TerminalCtx, "$" | "config" | "log">,
  args: { readonly event: NotifyEvent; readonly kind: string; readonly taskId: string; readonly message: string },
): Promise<void> => {
  const command = ctx.config.notifyCommand
  if (!command) return
  const { event, kind } = args
  if (ctx.config.notifyEvents ? !ctx.config.notifyEvents.includes(event) : event === "stage") return
  const id = args.taskId
  const message = args.message.replace(/\s+/g, " ").trim().slice(0, NOTIFY_MESSAGE_MAX)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const run = ctx.$`env ${`AW_EVENT=${event}`} ${`AW_KIND=${kind}`} ${`AW_TASK=${id}`} ${`AW_MESSAGE=${message}`} sh -c ${command}`
      .quiet()
      .nothrow()
      .then((out) => out.exitCode)
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), NOTIFY_TIMEOUT_MS)
    })
    const outcome = await Promise.race([run, deadline])
    if (outcome === "timeout") {
      await ctx.log("warn", `notifyCommand did not finish within ${(NOTIFY_TIMEOUT_MS / 1000).toString()}s for ${event} — abandoned (it may still be running)`)
    } else if (outcome !== 0) {
      await ctx.log("warn", `notifyCommand exited ${outcome.toString()} for ${event}${id ? ` (${id})` : ""}`)
    }
  } catch (err) {
    await ctx.log("warn", `notifyCommand failed for ${event}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

export const runTerminal = async (ctx: TerminalCtx, action: Action): Promise<TerminalReport> => {
  const report = await (async (): Promise<TerminalReport> => {
    switch (action.kind) {
      case "park":
        return runPark(ctx, action)
      case "done":
        return runDone(ctx, action)
      case "stop":
        return runStop(ctx, action)
      default:
        return { kind: "error", message: `runTerminal called with non-terminal action "${action.kind}"` }
    }
  })()
  // After the terminal's own bookkeeping — a notifier must never be able to
  // fail (or stall) a park/done/stop, only to announce one.
  await notifyTerminal(ctx, report)
  return report
}
