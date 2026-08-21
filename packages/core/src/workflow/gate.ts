import path from "node:path"
import type { Client, Log, Shell } from "../host.js"
import type { Config, ShipPublish } from "./state.js"
import { isEpicType, isSafeTaskId, parseTask, taskToInput, unknownFrontmatterKeys, type Task } from "../task/schema.js"
import { appendNote, auditNote, epicSiblings, extractPlan, extractRunBase, extractRunBranch, extractStopContext, findByIdIn, hasPlan, listByStatus, listClaimIds, moveTask, planHeadingCount, planRejectedNote, removeTaskFile, resolveTaskIdAnywhere, resolveTaskIdIn, rewriteTask, STATUSES } from "../task/store.js"
import { withoutPlanSections } from "../task/plan-section.js"
import { redact } from "../task/redact.js"
import { hasVerificationSection } from "./verdict.js"
import { unverifiedDepsCaveat } from "./declared-deps.js"
import type { TaskStatus } from "../task/statuses.js"
import { requestPlan } from "../task/plan-request.js"
import { commitPaths, ensureExcluded, gitActor } from "./git.js"
import { releaseWorktree } from "./isolate.js"
import type { AdoGateway } from "../source/ado-gateway.js"
import { shipPr, type ShipPrResult } from "./ship-pr.js"
import { PrBaseSchema, shipBaseFor } from "../config.js"

/**
 * The human gate moves — approve (task), approve-plan, replan, ship — shared by
 * both hosts. Previously hand-ported between the OpenCode driver (`doApprove`
 * etc., which toasted) and the Claude MCP server (`approveTask` etc., which
 * returned a structured result). This is the single source: each op locates the
 * task itself, performs the audited move + commit, and returns a `GateResult` the
 * host renders — the OpenCode driver toasts `message`, the Claude server feeds it
 * into its MCP `ok(...)` / CLI envelope. A retry that finds the task already at
 * the transition's target reports success (`alreadyDone`) so re-calls stay
 * harmless. Pure of host globals — everything comes through `GateCtx`.
 */

export interface GateCtx {
  readonly $: Shell
  readonly client: Client
  readonly log: Log
  readonly directory: string
  readonly config: Config
  /**
   * Whether a live loop is currently driving task `id` (refused by replan so we
   * never re-queue a task mid-build). The OpenCode host answers from its in-memory
   * session map; the Claude host from its single `active` loop or the on-disk stage
   * marker. Absent ⇒ nothing is driving.
   */
  readonly isDriving?: (id: string) => boolean
  /**
   * The Azure DevOps MCP gateway, for the ship gate's PR creation when the
   * engineering kind's platform is `ado`. Absent on a GitHub-only host — and
   * absent means the ship still succeeds, reporting only that no PR opened.
   */
  readonly adoGateway?: AdoGateway
}

/**
 * A result's severity, for hosts that surface it (the OpenCode toast, the hub's
 * message line). On a refusal: a task already at a forward status is `info`
 * ("nothing to do"), a genuine wrong-folder/not-found is `warning`.
 *
 * On a SUCCESS it marks a move that landed but carries a caveat — the ship gate
 * whose PR did not open is the case it exists for. Absent means an unqualified
 * success, which is what an ordinary move returns. The Claude host ignores it
 * (see `data` for the machine-readable half).
 */
export type GateVariant = "info" | "warning"

/**
 * A gate move's machine-readable half.
 *
 * `data.gate` (`"task" | "plan" | "ship"`) and `data.id` are the contract the
 * hosts branch on, and the approve family sets both on EVERY success arm — the
 * `alreadyDone` retries included. The unified `approve` verb is folder-driven,
 * so which gate it crossed is only knowable after the move; a host that needs to
 * act on it (the Claude/Qwen gate hook hands the turn back after a TASK gate,
 * instead of blocking it, so it can ask whether to plan now) must read it here.
 *
 * Never re-derive either from `message`: those strings are human prose that is
 * reworded freely, and matching on them is how a host silently starts guessing.
 * `data` is deliberately open (`Record<string, unknown>`) so verbs can add their
 * own keys — but these two are the shared vocabulary, matching the `gate: {kind,
 * id}` descriptor the MCP server already emits at its plan and ship gates.
 *
 * A REFUSAL may carry `data` too, and exactly one does today: the id-less
 * ambiguity below, whose `candidates` let a host ask which task was meant instead
 * of dead-ending. Such a payload deliberately carries NO `gate` key — `gate`
 * means "this gate was crossed", and putting one on a move that never happened is
 * how a host's continue-the-turn arm starts firing on refusals.
 */
export type GateResult =
  | { readonly ok: true; readonly message: string; readonly path: string; readonly data: Record<string, unknown>; readonly variant?: GateVariant }
  | { readonly ok: false; readonly message: string; readonly variant?: GateVariant; readonly data?: Record<string, unknown> }

/**
 * One task an id-less gate verb could have meant — the machine-readable half of
 * the "Multiple tasks awaiting" refusal, and of the slices a task gate leaves
 * behind. One shape for both, so a host validates one thing rather than two.
 *
 * `title` is what makes a choice answerable: an id alone is four random
 * characters and a slug, which is not something a human can pick between.
 */
export interface GateCandidate {
  readonly id: string
  readonly from: TaskStatus
  readonly title: string
  readonly priority: number
  /** The tracking epic this task is a slice of, when its frontmatter names one. */
  readonly epic?: string
}

/** Project a task to the candidate shape, omitting `epic` when it has none. */
const toCandidate = (task: Task, from: TaskStatus): GateCandidate => ({
  id: task.id,
  from,
  title: task.title,
  priority: task.priority,
  ...(task.epic ? { epic: task.epic } : {}),
})

/**
 * Commit the backlog move, unless `config.ignoreBacklog` (the default) says to
 * leave it alone — then just re-assert the `.git/info/exclude` entry instead.
 *
 * Exported for callers that write to a task file *outside* a gate move and must
 * commit it the same way (the hub's task editor). They must not re-derive the
 * `ignoreBacklog` policy — it lives here, once.
 */
export const commitBacklog = async ($: Shell, directory: string, config: Config, message: string): Promise<void> => {
  if (config.ignoreBacklog) {
    await ensureExcluded($, directory, config.tasksDir)
    return
  }
  await commitPaths($, directory, [config.tasksDir], message)
}

/** Locate which status folder a task id lives in (searches all statuses). */
export const findAnyStatus = async (ctx: GateCtx, id: string): Promise<Task | null> => {
  for (const s of STATUSES) {
    const t = await findByIdIn(ctx.$, ctx.directory, ctx.config.tasksDir, s, id)
    if (t) return t
  }
  return null
}

const statusFolder = (t: Task): string => path.basename(path.dirname(t.path))

/**
 * When every parse-based lookup missed, check whether an id-named FILE still
 * exists in some status folder — i.e. the task is right there on disk but its
 * frontmatter can't be parsed (`findByIdIn` swallows parse errors to null).
 * Returning that diagnosis instead of "no task found" stops the gate from
 * sending the human hunting for a file they can see. Null when the file is
 * genuinely absent (or parseable — then a parse-based lookup would have hit).
 */
const unparseableAt = async (ctx: GateCtx, id: string): Promise<string | null> => {
  // Every other id-taking helper (findByIdIn, resolveTaskIdIn, moveTask,
  // removeTaskFile, rewriteTask, loadState) gates on this; this one did not, and
  // it is reachable with a RAW id: `resolveGateId` returns null for an id the
  // store refuses, and each caller then carries the user's original string on to
  // its "no task found" branch. `cat`ing it made this a filesystem existence
  // oracle — and the message embeds the parse error, which quotes the offending
  // line back out of whatever it read.
  if (!id || !isSafeTaskId(id)) return null
  for (const s of STATUSES) {
    const file = path.join(ctx.directory, ctx.config.tasksDir, s, `${id}.md`)
    const out = await ctx.$`cat ${file}`.quiet().nothrow()
    if (out.exitCode !== 0) continue
    try {
      parseTask(`${id}.md`, out.stdout.toString(), file)
      return null
    } catch (err) {
      return `Task file ${ctx.config.tasksDir}/${s}/${id}.md exists but can't be parsed — fix its frontmatter: ${(err as Error).message}`
    }
  }
  return null
}

/**
 * Resolve a user-typed id — which may be a short-hash prefix (`f7k3`) rather than
 * the full `f7k3-add-rate-limit` — to the single canonical task id across all
 * status folders. An exact filename hit always wins; a prefix hitting several tasks
 * is a warning-variant ambiguity error. Returns `{ id }` to proceed, `{ error }` to
 * surface, or `null` when nothing matched (callers keep their own "no task found"
 * messaging). An empty query passes straight through (the folder-driven auto-gate).
 */
const resolveGateId = async (ctx: GateCtx, query: string): Promise<{ id: string } | { error: GateResult } | null> => {
  if (!query) return { id: query }
  const { $, directory, config, log } = ctx
  const r = await resolveTaskIdAnywhere($, directory, config.tasksDir, query, log)
  if (!r) return null
  if ("id" in r) return r
  return { error: { ok: false, message: `Ambiguous id "${query}" — matches ${r.ambiguous.join(", ")}. Use more characters.`, variant: "warning" } }
}

/**
 * Append a gate move's audit note, then perform the move — and when the move
 * fails, correct the note instead of leaving it asserting something untrue.
 *
 * Every gate verb has to write its note first: the note belongs to the file, and
 * after a successful move the file is somewhere else. But `moveTask` THROWS on a
 * duplicate destination, a failed `mv`, or a move that didn't land — and an
 * unguarded throw escapes a function whose contract is `GateResult`, so the
 * caller's commit, PR and worktree release never run while the task file claims
 * a transition it never made. That combination is unrecoverable by reading the
 * backlog, which is the only record a human has.
 *
 * So the pairing lives here rather than being re-derived per verb: one place
 * that owns "note, move, and on failure say so". `terminal.ts` runs the same
 * protocol for the loop's own terminal moves.
 */
const noteThenMove = async (
  ctx: GateCtx,
  ref: { readonly id: string; readonly path: string },
  to: TaskStatus,
  note: string,
  actor?: string | null,
): Promise<{ ok: true; path: string } | { ok: false; result: GateResult }> => {
  const { $, log } = ctx
  await appendNote($, ref, auditNote(note, new Date(), actor), log)
  try {
    return { ok: true, path: await moveTask($, ref, to) }
  } catch (err) {
    const why = (err as Error).message
    await log("warn", `loop(${ref.id}): move to ${to}/ failed after its audit note: ${why}`)
    await appendNote($, ref, auditNote(`Move to ${to}/ failed — ${why}; the task did not move`, new Date(), actor), log)
    return { ok: false, result: { ok: false, message: `Can't move "${ref.id}" to ${to}/: ${why}`, variant: "warning" } }
  }
}

/**
 * The slices of `task`'s epic still waiting in `draft/` — what a task gate's
 * follow-up names so the human can keep walking a slice set without typing a
 * second command.
 *
 * Best-effort on purpose. It runs AFTER the approval is committed, so a failed
 * listing must cost the next-slice line and never the move: the alternative is an
 * approval that reports failure for work that is already on disk. An empty result
 * (no epic, no siblings left, or a listing that threw) renders as no line at all,
 * which is exactly the pre-slice-set behaviour.
 */
const remainingSlices = async (ctx: GateCtx, task: Task, exceptId: string): Promise<GateCandidate[]> => {
  if (!task.epic) return []
  try {
    const drafts = await listByStatus(ctx.client, ctx.directory, ctx.config.tasksDir, "draft", ctx.log)
    return epicSiblings(drafts, task.epic, exceptId).map((t) => toCandidate(t, "draft"))
  } catch (err) {
    void ctx.log("warn", `could not list the remaining slices of epic "${task.epic}" — the approval stands, but its follow-up will not name the next one (${(err as Error).message})`)
    return []
  }
}

/** The `epic`/`siblings` half of a task gate's `data`, both omitted when empty. */
const sliceData = (task: Task, siblings: readonly GateCandidate[]): Record<string, unknown> => ({
  ...(task.epic ? { epic: task.epic } : {}),
  ...(siblings.length ? { siblings } : {}),
})

/** approve: a reviewed draft/ task → queued/ (audited note + commit). */
/**
 * Set or clear a task's `autoPlan` frontmatter flag in place, screening
 * off-schema keys exactly as `stripSupersededPlan` does (a rewrite serializes
 * through the schema, and zod STRIPS what it does not know). Best-effort by
 * construction: every caller runs AFTER its gate move committed, so a failure
 * here degrades to a warning riding the gate message and never unwinds the
 * move. Returns "" on success (or when the flag already matches), else a
 * leading-space warning sentence ready to append to a message.
 */
const writeAutoPlanFlag = async (ctx: GateCtx, ref: { readonly id: string; readonly path: string }, value: boolean): Promise<string> => {
  const act = value ? "arm auto-plan" : "clear auto-plan"
  try {
    const raw = await ctx.$`cat ${ref.path}`.quiet().nothrow()
    if (raw.exitCode !== 0) return ` Warning: could not ${act} — the task file could not be read.`
    const content = raw.stdout.toString()
    const parsed = parseTask(`${ref.id}.md`, content, ref.path)
    if ((parsed.autoPlan === true) === value) return ""
    const unknown = unknownFrontmatterKeys(content)
    if (unknown.length > 0) {
      return ` Warning: could not ${act} — the file carries off-schema frontmatter (${unknown.join(", ")}) that a rewrite would delete; edit the autoPlan key by hand.`
    }
    await rewriteTask(ctx.$, { id: ref.id, path: ref.path }, { ...taskToInput(parsed), autoPlan: value ? true : undefined }, ctx.log)
    return ""
  } catch (err) {
    return ` Warning: could not ${act} — ${(err as Error).message}.`
  }
}

export const approveTask = async (ctx: GateCtx, id: string, autoPlan?: boolean): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const draft = await findByIdIn($, directory, config.tasksDir, "draft", id)
  if (!draft) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    // A retry (model re-calling after a prior success, or a race with the
    // harness gate hook) lands here with the task already at the transition's
    // target — report success instead of an error so retries stay harmless.
    if (where === "queued") {
      // The retry carries the slice data too: `alreadyDone` is documented as
      // carrying the same contract as the move arm, and a repeated approve
      // mid-walk must not silently truncate the set the human is working through.
      const siblings = await remainingSlices(ctx, elsewhere!, id)
      // An idempotent retry must not lose an explicit flag either: a repeated
      // `approve <id> --auto-plan` arms the queued file exactly as the first
      // approve would have. Absent flag = leave the file alone (a bare retry
      // is a report, not a re-statement of intent).
      //
      // Unless a planner holds the file RIGHT NOW: `writeAutoPlanFlag` is a
      // read-modify-write (`cat` → parse → `rewriteTask`), so running it against
      // a task the PLAN stage is appending its plan to is a lost update — the
      // same hazard `replanQueued` refuses on, one verb over, and the reason the
      // claim marker is the cross-process signal. Unlike the move arms this one
      // still reports SUCCESS: the task is queued, which is what `approve` was
      // asked for; only the flag did not land, and the message says so with the
      // gate to use instead.
      const heldByPlanner = autoPlan ? (await listClaimIds($, directory, config.tasksDir, "queued")).includes(id) : false
      const autoNote = autoPlan && !heldByPlanner ? await writeAutoPlanFlag(ctx, { id, path: elsewhere!.path }, true) : ""
      const armed = autoPlan && !heldByPlanner && !autoNote
      const autoMessage = heldByPlanner
        ? ` Auto-plan was NOT armed — "${id}" is being planned right now, and rewriting its file would discard the plan being written; approve the plan yourself when it parks in ${config.tasksDir}/plan-review/.`
        : armed
          ? " Auto-plan armed — its plan will be approved automatically when it parks."
          : autoNote
      return {
        ok: true,
        message: `Task "${elsewhere!.title}" is already queued in ${config.tasksDir}/queued/ — nothing to do.${autoMessage}`,
        path: elsewhere!.path,
        data: {
          approved: true,
          alreadyDone: true,
          gate: "task",
          id,
          path: elsewhere!.path,
          ...(armed ? { autoPlan: true } : {}),
          next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage`,
          ...sliceData(elsewhere!, siblings),
        },
      }
    }
    return {
      ok: false,
      message: where
        ? `Can't approve "${id}": it's in ${where} — only draft tasks can be approved.`
        : ((await unparseableAt(ctx, id)) ?? `Can't approve "${id}": no task found.`),
    }
  }
  // A tracking epic is never approved — it only orders its child slices;
  // queuing it would have the loop plan/build the tracking file itself.
  if (isEpicType(draft.type)) {
    return {
      ok: false,
      message: `Can't approve "${id}": it is a tracking epic — approve its child slices instead, and close the epic by hand once every child has shipped.`,
      variant: "warning",
    }
  }
  // Refuse a draft that scans as carrying a secret — the same `redact` screen
  // the hub's task editor applies on save (routes/tasks.ts), which the
  // authoring path has no equivalent of: the task-author subagent writes with
  // the host's raw Write tool. The task gate is the one choke point every
  // draft passes on its way into the loop, where its body starts riding into
  // stage prompts, checkpoint commits, and possibly a PR. Gate verbs fail
  // closed; the fix costs one retask.
  const scan = redact(`${draft.title}\n${draft.body}`)
  if (scan.hits.length > 0) {
    return {
      ok: false,
      message: `Can't approve "${id}": the task looks like it contains a secret (${scan.hits.map((h) => h.pattern).join(", ")}) — remove it (retask ${id}), rotate the credential if it was real, then approve.`,
      variant: "warning",
    }
  }
  // Criteria-less tasks are legal (chores exist), so this is a NOTE, not a
  // refusal — but an empty list means VERIFY has nothing objective to judge
  // and the plan contract's `### Verification` has nothing to map, so the
  // human deciding "approve" is the right person to see it.
  const acceptanceNote =
    draft.acceptance.length === 0
      ? ` Note: it has no acceptance criteria — VERIFY will have nothing objective to check and the plan's ### Verification has nothing to map; use retask to add some if this task should have them.`
      : ""
  const actor = await gitActor($, directory)
  // The approval is authoritative about auto-plan: `--auto-plan` arms it, and a
  // plain approve on a draft that still carries the flag CLEARS it — a stale
  // opt-in from an earlier approve (retask sent it back to draft/) must not
  // silently skip a gate the human did not choose to skip this time.
  //
  // Written BEFORE the move, while the file is still in `draft/`. It is a
  // read-modify-write (`cat` → parse → `rewriteTask`), and `queued/` is the pool
  // a `watch` worker claims from: run one there and a claimer that lands between
  // the `cat` and the rewrite has its `> CLAIMED` note silently overwritten —
  // exactly the lost update the `alreadyDone` arm above refuses on `heldByPlanner`,
  // and with a `git commit` sitting inside the window on a tracked backlog. No
  // claim walk touches `draft/`, so there is no window here at all. It also puts
  // the frontmatter change INSIDE the gate's own backlog commit, where writing it
  // afterwards left it uncommitted.
  const autoNote = autoPlan
    ? await writeAutoPlanFlag(ctx, draft, true)
    : draft.autoPlan
      ? await writeAutoPlanFlag(ctx, draft, false)
      : ""
  // The note leads with `TASK_APPROVED_MARKER` (`Task approved`), which is what
  // retires the park gate's contract-refusal strikes — keep that prefix if this
  // text is reworded, or a task the park gate returned for triage gets one PLAN
  // attempt per approval instead of three, forever. Same writer/parser pairing
  // `retaskTask` keeps with `TASK_RESHAPED_MARKER`.
  const moved = await noteThenMove(ctx, draft, "queued", "Task approved — queued for planning", actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): task approved — queued for planning`)
  const autoMessage = autoPlan
    ? autoNote || " Auto-plan armed — when its plan parks, the plan gate is crossed automatically and BUILD follows (replan or a fresh approve clears it; the ship gate stays yours)."
    : draft.autoPlan
      ? autoNote || " Auto-plan cleared — this approve did not re-request it, so the plan parks for your review."
      : ""
  // After the move, so the just-approved slice is out of draft/ and cannot list
  // itself as its own successor.
  const siblings = await remainingSlices(ctx, draft, id)
  return {
    ok: true,
    message: `Task approved — "${draft.title}" queued in ${config.tasksDir}/queued/ for planning.${acceptanceNote}${autoMessage}`,
    path: newPath,
    data: {
      approved: true,
      gate: "task",
      id,
      path: newPath,
      ...(autoPlan && !autoNote ? { autoPlan: true } : {}),
      ...(acceptanceNote ? { acceptanceMissing: true } : {}),
      next: `workflow_start with id "${id}" (or workflow_claim) runs its PLAN stage`,
      ...sliceData(draft, siblings),
    },
  }
}

/**
 * Discard a queued task's superseded plan section before it goes back to
 * `draft/`. Reports whether it stripped, or why it deliberately did not.
 *
 * Best-effort by construction: the retask MOVE is what the human asked for, and
 * a plan left in the body is a degraded outcome, not a failed one — so every
 * failure arm warns and lets the move proceed. Never throws.
 *
 * The `unknownFrontmatterKeys` screen is the one arm that is a refusal rather
 * than an error: `rewriteTask` serializes through the schema, and zod STRIPS what
 * it does not know, so rewriting a file a human or a tracker sync put extra
 * frontmatter on would DELETE those keys. The hub screens its in-place edits the
 * same way for the same reason. Keeping a stale plan is recoverable; silently
 * dropping a task's off-schema fields is not.
 */
const stripSupersededPlan = async (ctx: GateCtx, task: Task): Promise<{ readonly stripped: boolean; readonly warn?: string }> => {
  if (!hasPlan(task)) return { stripped: false }
  try {
    const raw = await ctx.$`cat ${task.path}`.quiet().nothrow()
    if (raw.exitCode !== 0) return { stripped: false, warn: "its superseded plan was left in place — the task file could not be read" }
    const unknown = unknownFrontmatterKeys(raw.stdout.toString())
    if (unknown.length > 0) {
      return {
        stripped: false,
        warn: `its superseded plan was left in place — the file carries off-schema frontmatter (${unknown.join(", ")}) that a rewrite would delete; remove the plan section by hand`,
      }
    }
    await rewriteTask(ctx.$, { id: task.id, path: task.path }, { ...taskToInput(task), body: withoutPlanSections(task.body) }, ctx.log)
    return { stripped: true }
  } catch (err) {
    const why = (err as Error).message
    await ctx.log("warn", `loop(${task.id}): could not remove the superseded plan before re-shaping: ${why}`)
    return { stripped: false, warn: `its superseded plan was left in place — ${why}` }
  }
}

/**
 * retask: prepare a task for re-shaping by the authoring interview.
 *
 * A `draft/` task is already in the right place, so this is a no-op that reports
 * success. An approved `queued/` task is sent BACK to `draft/` first: reshaping
 * the goal invalidates the task-gate approval, which must be re-taken. Moving it
 * also keeps the authoring agent honest — it only ever writes `draft/*.md`, so by
 * the time it looks, the file is where it expects, and it can never author a
 * second copy under a live task's id (the duplicate this used to risk).
 *
 * The task is planless, or is MADE planless here: `replanTask` re-queues a
 * rejected task with its plan intact, so `queued/` is not the planless folder the
 * contract once assumed (`stripSupersededPlan`, and `TASK_RESHAPED_MARKER` for
 * the rejection that came with it).
 *
 * From `plan-review/` onward a plan is under an active gate or a live build, so
 * `replan` is the right verb and this refuses.
 */
export const retaskTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const draft = await findByIdIn($, directory, config.tasksDir, "draft", id)
  if (draft) {
    return {
      ok: true,
      message: `"${draft.title}" is a draft — reshape it.`,
      path: draft.path,
      data: { retask: true, alreadyDone: true, path: draft.path, id },
    }
  }
  const queued = await findByIdIn($, directory, config.tasksDir, "queued", id)
  if (!queued) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    return {
      ok: false,
      message: where
        ? `Can't retask "${id}": it's in ${where} — a task with a plan goes back via /agentic-workflow:engineering replan ${id}.`
        : ((await unparseableAt(ctx, id)) ?? `Can't retask "${id}": no task found.`),
      variant: "warning",
    }
  }
  // A queued task is claimed by `plan <id>` or by the claim walk's fallback to
  // the queued pool, and a crashed run can leave the marker behind either way —
  // moving the task would orphan it.
  const held = await listClaimIds($, directory, config.tasksDir, "queued")
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — release it first (/agentic-workflow:engineering doctor fix).`, variant: "warning" }
  }
  const actor = await gitActor($, directory)
  // A queued task is USUALLY planless, but not always: `replanTask` re-queues a
  // rejected task with its plan intact, so the retry path routinely parks a
  // planful task in the one folder this verb accepts. Discard that plan here —
  // it was written against the goal the interview is about to rewrite, and left
  // in the body it rides back into the next PLAN pass as `priorPlan` (and into
  // the plan gate's stacked-heading caveat). See `stripSupersededPlan`.
  const strip = await stripSupersededPlan(ctx, queued)
  // The note leads with `TASK_RESHAPED_MARKER` (`Sent back to draft`), which is
  // what retires a pending plan rejection — keep that prefix if this text is
  // reworded, or `pendingPlanRejection` will thread the old plan's critique into
  // the re-planned task.
  const why = oneLineReason(reason)
  const moved = await noteThenMove(
    ctx,
    queued,
    "draft",
    `Sent back to draft for re-shaping — approval withdrawn${strip.stripped ? "; superseded plan removed" : ""}${why ? ` — ${why}` : ""}`,
    actor,
  )
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): sent back to draft for re-shaping`)
  return {
    ok: true,
    message:
      `"${queued.title}" sent back to ${config.tasksDir}/draft/ — reshape it, then approve it again.` +
      (strip.stripped ? " Its superseded plan was removed." : "") +
      (strip.warn ? ` Note: ${strip.warn}` : ""),
    path: newPath,
    data: {
      retask: true,
      path: newPath,
      id,
      ...(strip.stripped ? { planRemoved: true } : {}),
      ...(strip.warn ? { planKept: strip.warn } : {}),
      next: `/agentic-workflow:engineering approve ${id} re-queues it once reshaped`,
    },
  }
}

/**
 * What a user can actually recover a deleted task from, phrased for the config
 * they are actually running.
 *
 * `ignoreBacklog` DEFAULTS TO TRUE — the backlog is kept out of git entirely —
 * so the stock "git history keeps it" reassurance is false for most installs.
 * Lead with the default rather than the exception.
 */
const recoveryHint = (config: Config): string =>
  config.ignoreBacklog
    ? "the backlog is untracked (ignoreBacklog defaults to true), so this CANNOT be undone."
    : "the backlog is committed, so git history keeps a copy, but it cannot be undone from the working tree."

/**
 * remove: hard-delete a task from the backlog entirely.
 *
 * Unlike every other gate this does NOT move the task to another folder — the
 * file is removed and the removal committed, so the task leaves the active
 * backlog for good. Git history retains it ONLY when the backlog is tracked,
 * which is not the default (`ignoreBacklog: true`); prefer `abandonTask` when
 * the user wants the task out of the way rather than gone. Works from ANY
 * status folder: cleaning up a stale draft, a rejected plan, or a finished task
 * is all the same delete.
 *
 * Refuses a task a live loop is driving, or one still holding a claim marker —
 * deleting the file out from under a run would strand its worktree/marker.
 * Idempotent by design: an id that resolves to nothing is reported as success
 * (`alreadyDone`), matching `rm -f`, so a double-click or a retry after a prior
 * success stays harmless. Any worktree the task owned is released best-effort.
 *
 * **`force` is the confirmation.** Without it this resolves the id, runs every
 * guard, and reports what WOULD be deleted without touching the file. The CLI
 * hosts had no confirmation at all: Claude dispatches `remove` from a
 * UserPromptSubmit hook that then blocks the turn, so the verb prose telling the
 * model to "confirm the id first" could never run, and opencode deleted straight
 * out of `command.execute.before`. Only the hub — which has its own <Confirm> —
 * passed a decision the user had actually made. Since ids are prefix-resolvable,
 * a typo'd short handle could resolve to a different real task and delete it.
 */
export const removeTask = async (ctx: GateCtx, id: string, force = false): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const task = await findAnyStatus(ctx, id)
  if (!task) {
    // Genuinely gone → idempotent success. But an id-named file that merely
    // fails to parse is still removable — surface that so a broken task can be
    // deleted rather than reported "already removed".
    const unparseable = await unparseableAt(ctx, id)
    if (unparseable) return { ok: false, message: `Can't remove "${id}": ${unparseable}`, variant: "warning" }
    return { ok: true, message: `No task "${id}" — nothing to remove.`, path: "", data: { removed: true, alreadyDone: true, id } }
  }
  const from = statusFolder(task)
  // A claim marker means a loop may be mid-run on it; refuse rather than orphan
  // the marker (mirrors retask's guard). A stale one is cleared by doctor fix.
  const held = await listClaimIds($, directory, config.tasksDir, from)
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  if (!force) {
    return {
      ok: false,
      variant: "info",
      message:
        `Remove "${task.title}" (${id}) from ${config.tasksDir}/${from}/? This DELETES the task file — ` +
        `${recoveryHint(config)} Nothing has been deleted. Re-run with --force to confirm: ` +
        `/agentic-workflow:engineering remove ${id} --force`,
    }
  }
  const removed = await removeTaskFile($, { id, path: task.path })
  await commitBacklog($, directory, config, `loop(${id}): task removed from backlog`)
  // A parked in-progress/in-review task can own a worktree; free it so the
  // delete doesn't leave an orphan tree behind (best-effort, never throws).
  await releaseWorktree($, log, directory, config, id)
  return {
    ok: true,
    message: `"${task.title}" removed from ${config.tasksDir}/${from}/.`,
    path: removed,
    data: { removed: true, path: removed, id, from },
  }
}

/**
 * abandon: cancel a task by moving it to `abandoned/` — the reversible
 * counterpart to `remove`.
 *
 * `abandoned` has always been a first-class status: it is in the vocabulary,
 * `canTransition` already admits it from every non-terminal folder, and `status`
 * renders its count. What it never had was a way in. The only cancellation verb
 * users could reach was `remove`, which deletes; the docs told them to reach
 * `abandoned/` "by hand" — on opencode via a move tool that host does not even
 * register. So the counter was unreachable and the safe path went unused.
 *
 * Guards mirror `remove` exactly (live loop, claim marker), because the hazard
 * is the same: moving the file out from under a run strands its worktree and
 * marker. Unlike `remove` the file survives, so this needs no `--force`.
 */
export const abandonTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) {
    return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  }
  const task = await findAnyStatus(ctx, id)
  if (!task) {
    return { ok: false, message: (await unparseableAt(ctx, id)) ?? `No task "${id}" to abandon.`, variant: "warning" }
  }
  const from = statusFolder(task)
  if (from === "abandoned") {
    return { ok: true, message: `"${task.title}" is already abandoned.`, path: task.path, data: { abandoned: true, alreadyDone: true, id } }
  }
  // `completed` is terminal in the same sense abandoned is — a shipped task is
  // not cancellable, and store.ts's canTransition says so. Name the rule rather
  // than letting moveTask fail obscurely.
  if (from === "completed") {
    return { ok: false, message: `Can't abandon "${id}": it's already completed — shipped work isn't cancellable.`, variant: "warning" }
  }
  const held = await listClaimIds($, directory, config.tasksDir, from)
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  const why = oneLineReason(reason)
  const moved = await noteThenMove(
    ctx,
    { id, path: task.path },
    "abandoned",
    `Abandoned from ${from}${why ? ` — ${why}` : ""}`,
    await gitActor($, directory),
  )
  // Same rule the terminal handlers follow: a thrown move must not escape a
  // function whose contract is GateResult, leaving a note asserting a move that
  // never happened. `noteThenMove` also corrects the note, which the local
  // try/catch this replaced did not.
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): abandoned${why ? ` — ${why}` : ""}`)
  // A parked task can own a worktree; free it the way remove/ship do.
  await releaseWorktree($, log, directory, config, id)
  return {
    ok: true,
    message: `"${task.title}" abandoned — moved to ${config.tasksDir}/abandoned/.`,
    path: newPath,
    data: { abandoned: true, path: newPath, id, from },
  }
}

/** approve-plan: a plan-review/ task with an Implementation Plan → in-progress/. */
export const approvePlan = async (ctx: GateCtx, id: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const task = await findByIdIn($, directory, config.tasksDir, "plan-review", id)
  if (!task) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "in-progress") {
      return {
        ok: true,
        message: `Plan for "${elsewhere!.title}" is already approved — parked in ${config.tasksDir}/in-progress/. Nothing to do.`,
        path: elsewhere!.path,
        data: { approved: true, alreadyDone: true, gate: "plan", id, path: elsewhere!.path, next: `workflow_start with id "${id}", or workflow_claim` },
      }
    }
    return {
      ok: false,
      message:
        where === "queued"
          ? `Can't approve the plan for "${id}": it's still queued — the loop hasn't planned it yet (workflow_start runs its PLAN stage).`
          : where === "draft"
            ? `Can't approve the plan for "${id}": it's a draft — approve the task first with workflow_task_approve.`
            : where
              ? `Can't approve the plan for "${id}": it's in ${where} — only plan-review tasks can be plan-approved.`
              : ((await unparseableAt(ctx, id)) ?? `Can't approve the plan for "${id}": no task found.`),
    }
  }
  // Host-neutral pointer: this message is surfaced verbatim on both hosts (the
  // OpenCode toast and the Claude tool result), so it names the `replan` verb
  // generically rather than a host-specific command/tool.
  if (!hasPlan(task)) return { ok: false, message: `Task "${id}" has no Implementation Plan — send it back to planning with replan.`, variant: "warning" }
  // The park gate (`runPark`) is the plan contract's only enforcement point,
  // and it is bypassable: a plan hand-edited in plan-review/, or a task moved
  // there by the low-level workflow_move, re-enters here unchecked. WARN, never
  // refuse — this gate is kind-agnostic (GateCtx carries no manifest, so it
  // cannot know whether the parked kind even demands a contract), and refusing
  // would strand the task with no verb better than the replan the human just
  // decided against. The caveats ride the success message the human is reading
  // at the exact moment "approve anyway" is still their call.
  const planText = extractPlan(task) ?? ""
  const caveats = [
    !hasVerificationSection(planText)
      ? "the plan has no ### Verification subsection — the acceptance-criteria map is missing and no discovered checks will run"
      : undefined,
    planHeadingCount(task.body) > 1
      ? "the body carries more than one ## Implementation Plan heading — superseded plan text remains in the task's prose"
      : undefined,
    // Repeated here rather than left to the park note because the two gates
    // have different readers: the park suffix is a toast at the moment the plan
    // lands, and this is the message in front of the human at the moment the
    // approval is still theirs to withhold. An unprovable dependency is the one
    // plan defect whose cost is paid a whole iteration later, in a BUILD that
    // fails on an install rather than on the work.
    unverifiedDepsCaveat(planText),
  ].filter((c): c is string => !!c)
  const caveatNote = caveats.length > 0 ? ` Note: ${caveats.join("; ")}.` : ""
  const actor = await gitActor($, directory)
  const moved = await noteThenMove(ctx, task, "in-progress", "Plan approved — parked for execution", actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): plan approved — parked for execution`)
  return {
    ok: true,
    message: `Plan approved — "${task.title}" parked in ${config.tasksDir}/in-progress/ for execution.${caveatNote}`,
    path: newPath,
    data: {
      approved: true,
      gate: "plan",
      id,
      path: newPath,
      ...(caveats.length > 0 ? { caveats } : {}),
      next: `workflow_start with id "${id}", or workflow_claim`,
    },
  }
}

/**
 * The most a gate reason may carry onto its audit note. Generous — a
 * fused hub review plus a prior run's attempt digest fits — but bounded: the
 * note is ONE line in a file humans read, and no writer upstream bounds it
 * (the hub joins per-line review comments, the CLI takes free text). This is
 * the single choke point every writer passes through.
 */
export const REPLAN_REASON_MAX = 1200

/**
 * A gate reason (rejection, re-shape, cancellation) flattened to one
 * audit-note-safe line, or `undefined`.
 *
 * An audit note is a single `> …` line closed by a bracketed stamp; an embedded
 * newline breaks that shape — line 2 loses the `> ` prefix and the stamp
 * detaches — so neither the audit trail nor the note parsers
 * (`extractReplanReason`, which threads the reason into the next PLAN pass's
 * prompt, `extractRunBranch`, `extractStopContext`) can read the tail back, and
 * the orphaned lines read as PROSE: `auditTailIndex` stops seeing the boundary,
 * so they ride into every later `{{goal}}`.
 *
 * EVERY reason writer goes through here — `replanTask`/`replanQueued`,
 * `retaskTask`, `abandonTask` — because the hazard is the shape of the note, not
 * the identity of the verb. retask and abandon interpolated raw reasons for a
 * while, which the hub's `<textarea>` (`z.string().trim()` does not touch
 * interior newlines) reached directly.
 *
 * Clamped to `REPLAN_REASON_MAX` with a trailing ellipsis. Pure.
 */
export const oneLineReason = (reason?: string): string | undefined => {
  const flat = reason?.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length > REPLAN_REASON_MAX ? `${flat.slice(0, REPLAN_REASON_MAX)}…` : flat
}

/**
 * Stamp `id` plan-next so the next claim/watch walk re-plans it before the rest
 * of the queued pool. Best-effort — a missing marker only costs the scheduling
 * hint (the ordinary queue walk still re-plans the task), so a failed write
 * warns rather than failing the gate. Written AFTER the gate's commit so the
 * ephemeral marker never rides into a tracked backlog's replan commit.
 */
const markPlanNext = async (ctx: GateCtx, id: string, actor: string | null): Promise<void> => {
  const marked = await requestPlan(ctx.$, ctx.directory, ctx.config.tasksDir, id, { by: actor, source: "replan" })
  if (!marked) await ctx.log("warn", `loop(${id}): could not write the plan-next request marker — the task is queued but not prioritized`)
}

/**
 * replan aimed at a task already sitting in queued/ — the retry arm. A fresh
 * reason still matters: record it (the same note shape `extractReplanReason`
 * parses) and restamp the plan-next marker — unless a claim marker says a
 * planner holds the file RIGHT NOW: appending to a file the plan author is
 * rewriting is a lost update, and the run holding the claim is already doing
 * what this verb asks for.
 */
const replanQueued = async (ctx: GateCtx, task: Task, reason?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const id = task.id
  const held = await listClaimIds($, directory, config.tasksDir, "queued")
  if (held.includes(id)) {
    // The typed reason is NOT recorded on this arm (appending to a file the
    // live plan author is rewriting is a lost update), so echo it back —
    // otherwise the human's one copy of it dies with this refusal and the
    // revised plan gets rejected for the same unstated thing all over again.
    const flat = oneLineReason(reason)
    return {
      ok: false,
      message:
        `Task "${id}" is being planned right now — its revised plan will park in ${config.tasksDir}/plan-review/; replan that plan when it lands.` +
        (flat ? ` Your reason was NOT recorded — re-send it then: ${flat}` : ""),
      variant: "info",
    }
  }
  const actor = await gitActor($, directory)
  const flat = oneLineReason(reason)
  if (flat) {
    await appendNote($, task, auditNote(planRejectedNote(flat), new Date(), actor), log)
    await commitBacklog($, directory, config, `loop(${id}): rejection reason recorded — marked plan-next`)
  }
  await markPlanNext(ctx, id, actor)
  return {
    ok: true,
    message: `"${task.title}" (${id}) is already queued in ${config.tasksDir}/queued/ — marked plan-next; the next PLAN pass re-plans it${flat ? " and addresses the new reason" : ""}.`,
    path: task.path,
    data: { requeued: true, alreadyDone: true, id, path: task.path, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it now` },
  }
}

/**
 * replan: a rejected plan-review/ or cap-tripped in-progress/ task → queued/,
 * stamped plan-next so the very next PLAN pass — a host chaining one
 * immediately, or the next claim/watch walk — picks it up first and parks a
 * revised plan back in plan-review/. `isDriving` refuses a task a live loop is
 * currently driving (so we never re-queue a task mid-build).
 */
export const replanTask = async (ctx: GateCtx, id: string, reason?: string): Promise<GateResult> => {
  const { $, directory, config } = ctx
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  if (ctx.isDriving?.(id)) return { ok: false, message: `Task "${id}" is being driven by a live loop — stop it first (/agentic-workflow:engineering stop).`, variant: "warning" }
  const task =
    (await findByIdIn($, directory, config.tasksDir, "plan-review", id)) ??
    (await findByIdIn($, directory, config.tasksDir, "in-progress", id))
  if (!task) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "queued") return replanQueued(ctx, elsewhere!, reason)
    return {
      ok: false,
      message: where
        ? `Can't replan "${id}": it's in ${where} — only plan-review or in-progress tasks can be sent back to planning.`
        : ((await unparseableAt(ctx, id)) ?? `Can't replan "${id}": no task found.`),
    }
  }
  // `isDriving` is PER-PROCESS — it walks an in-memory Map local to one plugin
  // instance — so a replan issued from the hub or the Claude MCP server sails
  // past it while an opencode loop is mid-BUILD, and the move then releases that
  // live run's claim marker out from under it. The marker is the cross-process
  // signal; retask and remove already check it, replan did not.
  const held = await listClaimIds($, directory, config.tasksDir, statusFolder(task))
  if (held.includes(id)) {
    return { ok: false, message: `Task "${id}" holds a claim marker — a loop may be driving it; stop it or run /agentic-workflow:engineering doctor fix first.`, variant: "warning" }
  }
  const actor = await gitActor($, directory)
  // A cap-stopped in-progress task carries the stopped run's attempts digest
  // (`stopContextNote`, written by runStop) — fuse it into the rejection
  // reason so the next PLAN pass plans against what every attempt kept failing
  // on. Without this, everything the run learned dies at clearState and the
  // human's typed reason is the only carrier — the archaeology design 10
  // eliminated for gate rejections, back again for cap trips. plan-review
  // tasks have no stopped run, so nothing fuses there.
  const stopContext = statusFolder(task) === "in-progress" ? extractStopContext(task) : undefined
  const fused = [oneLineReason(reason), stopContext ? `prior run: ${stopContext}` : undefined].filter(Boolean).join(" — ")
  // A human who rejected one plan wants eyes on the revision: a task that opted
  // into auto-plan at its task gate has that opt-in withdrawn here, or the
  // revised plan would cross the gate this rejection just closed.
  //
  // Cleared BEFORE the move, for `approveTask`'s reason and more sharply: this
  // verb lands the task in `queued/` AND stamps it plan-next, so the very next
  // claim walk takes it FIRST — running a `cat`→parse→`rewriteTask` after that
  // races a planner that may already hold the file, and the loser's write is
  // silently lost. `plan-review/` and `in-progress/` are claim-checked a few
  // lines above and neither is a pool this verb leaves claimable, so there is no
  // window on this side.
  const autoNote = task.autoPlan ? await writeAutoPlanFlag(ctx, task, false) : ""
  const autoMessage = task.autoPlan ? autoNote || " Auto-plan cleared — the revised plan parks for your review." : ""
  // One formatter (`planRejectedNote`) for every HUMAN rejection note — the
  // park gate's own mechanical contract refusal writes the same shape via the
  // TAGGED sibling `contractRejectedNote`, so `extractReplanReason` parses
  // both back identically but `unaddressedRejectionCount` counts only the
  // tagged one toward the 3-strike auto-draft-dump; a hand-built copy here is
  // how writer and parser drift. Re-flattened so the fused whole respects the
  // one-line clamp.
  const moved = await noteThenMove(ctx, task, "queued", planRejectedNote(oneLineReason(fused)), actor)
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): plan rejected — re-queued for planning`)
  await markPlanNext(ctx, id, actor)
  return {
    ok: true,
    // The id rides in the MESSAGE, not just `data` — on the Claude host the
    // model chains the next PLAN pass from this text alone (gate-command.mjs
    // surfaces only the message), and `workflow_start` needs a copyable id.
    message: `Plan rejected for "${task.title}" (${id}) — re-queued in ${config.tasksDir}/queued/ as plan-next; the next PLAN pass addresses the rejection and parks a revised plan in plan-review/.${autoMessage}`,
    path: newPath,
    data: { requeued: true, id, path: newPath, next: `workflow_start with id "${id}" (or workflow_claim) re-plans it now` },
  }
}

/** The branch a publish outcome names, or a stand-in when `shipPr` could not say. */
const shipBranch = (pr: ShipPrResult): string => pr.branch ?? "the task branch"

/**
 * The publish half of a ship, rendered onto the `GateResult.message` every
 * surface shows verbatim (opencode toast, the hub card).
 *
 * A ship that published less than a PR is a NOTE, never a failure — for two
 * quite different reasons that this one function has to keep apart:
 *
 *  - `push` and `local` did exactly what the human asked for. The note tells
 *    them where the branch stands and how to publish it later; it is not an
 *    apology.
 *  - In `pr` mode an unopened PR really is a shortfall, but still not a failed
 *    ship. `shipPr` never throws, no-ops entirely for a hand-authored task with
 *    no `feature/<id>` branch, and several of its reasons — `ado config
 *    missing`, `ado.repository not configured` — are plain configuration states
 *    where a PR was never possible. By the time it runs, the task is already
 *    audited, moved to `completed/`, and committed.
 *
 * What it must not do is go SILENT, which is what it used to do: the reason went
 * only into an audit note, invisible under the default `ignoreBacklog: true`
 * that never commits it, and the user read an unqualified "completed".
 *
 * It CAN now say whether the branch was pushed, which it once could not:
 * `attempted` covers two worlds — `git push failed` (not pushed) and a `gh`/ADO
 * create failure (pushed) — and `ShipPrResult.pushed` is the field that tells
 * them apart, so the caveat names the half that actually failed.
 */
const publishOutcome = (pr: ShipPrResult): string => {
  if (!pr.attempted) return ""
  if (pr.url) return ` PR: ${pr.url}${pr.base ? ` (onto ${pr.base})` : ""}`
  if (pr.mode === "local") return ` Branch ${shipBranch(pr)} was kept local — nothing was pushed. Ship it again with publish "pr" (or "push") to publish it.`
  if (pr.mode === "push") {
    return pr.pushed
      ? ` Branch ${shipBranch(pr)} pushed; no PR was opened (shipPublish: push). Ship it again with publish "pr" to open one.`
      : ` Note: ${shipBranch(pr)} was not pushed — ${pr.reason ?? "reason unknown"}. The task is completed; publish it when you're ready.`
  }
  const half = pr.pushed ? `the branch was pushed, but no PR was opened` : `the branch was not pushed, so no PR was opened`
  return ` Note: ${half} — ${pr.reason ?? "reason unknown"}. The task is completed; open one when you're ready.`
}

/**
 * Whether a ship published LESS than it was asked to — the one case that
 * warrants a warning.
 *
 * Keyed on the mode, not on the absence of a URL: a `local` ship has no URL by
 * design and a `push` ship opens no PR by design, and warning about either would
 * be shouting at the human for the choice they just made. Only the shortfall of
 * the mode that was actually requested counts.
 */
const publishMissed = (pr: ShipPrResult): boolean => pr.attempted && (pr.mode === "pr" ? !pr.url : pr.mode === "push" ? !pr.pushed : false)

/**
 * The audit note recording what a ship published, or null when there was nothing
 * to publish (no branch — `shipPr` never even tried).
 *
 * Every wording here is chosen to stay OUT of `prAlreadyRecorded`'s regex below
 * except the two that mean "a PR exists". That regex is what lets a `local` or
 * `push` ship be published later: it must read the trail and conclude no PR was
 * ever opened, so only an actual PR may speak in those terms.
 */
const publishNote = (pr: ShipPrResult): string | null => {
  if (!pr.attempted) return null
  if (pr.url) return `${pr.created ? "PR opened" : "PR already open"} — ${pr.url}`
  if (pr.mode === "local") return `Not published — branch ${shipBranch(pr)} kept local`
  if (pr.mode === "push") return pr.pushed ? `Branch pushed — ${shipBranch(pr)}` : `Branch not pushed — ${pr.reason ?? "reason unknown"}`
  return `PR not opened — ${pr.reason ?? "reason unknown"}`
}

/**
 * Matches any of `publishNote`'s wordings — not just the PR ones — so the
 * completed/ retry arm can tell "nothing was ever attempted" (a genuine crash
 * before `shipPr` ran) from "a publish outcome is already on record" (a
 * `local`/`push` ship that finished on purpose). Only the former may retry
 * without an explicit `publish` flag — once ANY outcome is on record, the
 * flag is what asks for more, same contract `approveAny` already enforces.
 */
const PUBLISH_RECORDED_RE = /\b(PR (opened|already open)|Not published|Branch (pushed|not pushed)|PR not opened) — /

/** The `loop(<id>): …` backlog commit subject paired with `publishNote`. */
const publishCommitSubject = (pr: ShipPrResult): string =>
  pr.url ? `PR ${pr.created ? "opened" : "linked"}` : pr.mode === "local" ? "kept local" : pr.mode === "push" ? (pr.pushed ? "branch pushed" : "branch not pushed") : "PR not opened"

/**
 * Write a ship's publish outcome to the audit trail: one note, one backlog
 * commit. Shared by the main path and the already-completed retry arm so the two
 * can never word the same outcome differently — the trail is what
 * `prAlreadyRecorded` later reads to decide whether a PR still needs opening.
 */
const recordPublish = async (ctx: GateCtx, ref: { readonly id: string; readonly path: string }, pr: ShipPrResult): Promise<void> => {
  const note = publishNote(pr)
  if (!note) return
  const { $, directory, config, log } = ctx
  await appendNote($, ref, auditNote(note, new Date()), log)
  await commitBacklog($, directory, config, `loop(${ref.id}): ${publishCommitSubject(pr)}`)
}

/**
 * A per-ship `--base=<ref>` override, normalized, or a refusal. `undefined` when
 * none was given — which is not the same as an empty one, and must stay
 * distinguishable so "no override" falls through to the recorded/config rungs
 * while a blank string refuses.
 */
const baseOverride = (base?: string): { readonly value: string } | { readonly error: GateResult } | undefined => {
  if (base === undefined) return undefined
  const parsed = PrBaseSchema.safeParse(base)
  return parsed.success
    ? { value: parsed.data }
    : { error: { ok: false, message: `Invalid base branch "${base}" — ${parsed.error.issues[0]?.message ?? "not a branch name"}.` } }
}

/** The `data.pr` descriptor a ship reports — the machine-readable twin of `publishNote`. */
const publishData = (pr: ShipPrResult): Record<string, unknown> => ({
  mode: pr.mode,
  pushed: pr.pushed,
  ...(pr.branch ? { branch: pr.branch } : {}),
  ...(pr.base ? { base: pr.base } : {}),
  ...(pr.url ? { url: pr.url } : { opened: false, ...(pr.reason ? { reason: pr.reason } : {}) }),
})

/**
 * ship: an in-review/ task → completed/ (the final human gate).
 *
 * `publish` is the human's per-ship override of the repo's `shipPublish`: open
 * the draft PR (the default), push the branch only, or keep everything local.
 * The MOVE is unconditional — every mode completes the task — and only what
 * leaves the machine varies.
 */
export const shipTask = async (ctx: GateCtx, id: string, kind = "engineering", publish?: ShipPublish, base?: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  // Refuse a malformed base BEFORE anything moves. `shipPr` runs after the task
  // is already in completed/, so validating there would leave the human with a
  // shipped-but-unpublished task and a flag error — the move is not undoable.
  // Re-validated here rather than trusted from the host: this arrives as a model
  // tool argument or an unvalidated hub body.
  const wantedBase = baseOverride(base)
  if (wantedBase && "error" in wantedBase) return wantedBase.error
  const resolved = await resolveGateId(ctx, id)
  if (resolved && "error" in resolved) return resolved.error
  if (resolved) id = resolved.id
  const t = await findByIdIn($, directory, config.tasksDir, "in-review", id)
  if (!t) {
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    if (where === "completed") {
      // Two quite different journeys land here, and one arm serves both.
      //
      // A crash between the completed/ move and shipPr (a slow network call)
      // leaves the task completed with the branch unpushed and NO PR — and this
      // retry is the only path back. It is ALSO the publish-later path: a `push`
      // or `local` ship deliberately opened no PR, and shipping the task again
      // with `publish: "pr"` is how the human publishes it afterwards. shipPr is
      // idempotent (push re-runs, an existing PR is reused), so re-attempt it
      // unless the task file already records an opened/linked PR — which is why
      // no note written for `push`/`local` may use those words.
      const done = elsewhere!
      const data: Record<string, unknown> = { completed: done.path, alreadyDone: true, gate: "ship", id }
      let tail = " Nothing to do."
      // Hoisted: `pr` is scoped to the re-attempt below, but the variant is
      // decided on the return. A retry that STILL can't publish what was asked
      // for warns for the same reason the main path does.
      let missedPublish = false
      const prAlreadyRecorded = /\bPR (opened|already open) — /.test(done.body)
      const publishAlreadyRecorded = PUBLISH_RECORDED_RE.test(done.body)
      if (!prAlreadyRecorded && (!publishAlreadyRecorded || publish)) {
        const pr = await shipPr($, log, directory, config, kind, id, done.title, ctx.adoGateway, {
          branch: extractRunBranch(done),
          publish,
          base: shipBaseFor(config, kind, { override: wantedBase?.value, recorded: extractRunBase(done) }),
          ...(wantedBase?.value ? { baseExplicit: true } : {}),
        })
        data.publish = pr.mode
        if (pr.attempted) {
          data.pr = publishData(pr)
          await recordPublish(ctx, { id, path: done.path }, pr)
          // Same rule as the main path: a retry that still can't publish must
          // say so, not report "nothing to do".
          tail = publishOutcome(pr)
        }
        missedPublish = publishMissed(pr)
      }
      await releaseWorktree($, log, directory, config, id, kind)
      return { ok: true, message: `"${done.title}" is already completed.${tail}`, path: done.path, data, ...(missedPublish ? { variant: "warning" as const } : {}) }
    }
    return { ok: false, message: elsewhere ? `Can't ship "${id}": it's in ${where}, not in-review/.` : ((await unparseableAt(ctx, id)) ?? `No in-review task "${id}".`) }
  }
  const moved = await noteThenMove(ctx, { id, path: t.path }, "completed", "Shipped — moved to completed", await gitActor($, directory))
  if (!moved.ok) return moved.result
  const newPath = moved.path
  await commitBacklog($, directory, config, `loop(${id}): shipped — completed`)

  const pr = await shipPr($, log, directory, config, kind, id, t.title, ctx.adoGateway, {
    branch: extractRunBranch(t),
    publish,
    base: shipBaseFor(config, kind, { override: wantedBase?.value, recorded: extractRunBase(t) }),
    ...(wantedBase?.value ? { baseExplicit: true } : {}),
  })
  const data: Record<string, unknown> = { completed: newPath, gate: "ship", id, publish: pr.mode }
  if (pr.attempted) {
    data.pr = publishData(pr)
    await recordPublish(ctx, { id, path: newPath }, pr)
  }
  // The task is done: its worktree — kept across every earlier run so retries
  // and recoveries build on prior iterations — is finally disposable. The
  // branch survives, so the PR opened just above is unaffected — and so is a
  // `local` ship's unpushed branch, which is the ONLY copy of that work.
  await releaseWorktree($, log, directory, config, id, kind)
  // A caveated ship is still a ship: `ok` stays true (the CLI exits 0, no host
  // reads it as a refusal) and the variant is what makes the note VISIBLE rather
  // than a green toast the user scrolls past.
  return { ok: true, message: `"${t.title}" completed.${publishOutcome(pr)}`, path: newPath, data, ...(publishMissed(pr) ? { variant: "warning" as const } : {}) }
}

/** Which task a folder-driven gate shortcut should act on. */
export type GatePick =
  | { readonly ok: true; readonly id: string; readonly from: TaskStatus }
  | { readonly ok: false; readonly kind: "none" }
  | {
      readonly ok: false
      readonly kind: "message"
      readonly message: string
      readonly variant: GateVariant
      /**
       * The tasks that made an id-less scan ambiguous — present ONLY on that arm,
       * and ≥2 by construction. A caller turns them into a "which one?" question;
       * absent means there is nothing to choose between and the message stands
       * alone.
       */
      readonly candidates?: readonly GateCandidate[]
    }

/** Statuses "ahead" of every gate — a task there has already advanced, so a gate no-op is informational, not an error. */
const FORWARD_STATUSES: readonly TaskStatus[] = ["queued", "in-progress", "completed"]

/**
 * Resolve the single task a shortcut should act on.
 *
 * `tiers` are searched in priority order. With `id`: the task must be in some
 * folder across all tiers (flattened — priority is irrelevant, since a task
 * lives in exactly one folder). Without `id`: the *first tier with any
 * candidate* decides — exactly one candidate there advances, two+ is an
 * ambiguity within that tier. So a lower tier never breaks a higher tier's tie,
 * and a non-empty higher tier is never bypassed. Every tier empty → `none`.
 * Never guesses.
 *
 * `skip` drops candidates from the id-less scan only. An explicit id always
 * reaches its task, so the specific gate op still reports why it can't advance.
 */
export const resolveGateTask = async (
  ctx: GateCtx,
  id: string,
  tiers: readonly (readonly TaskStatus[])[],
  skip?: (task: Task) => boolean,
): Promise<GatePick> => {
  const { $, client, directory, config, log } = ctx
  if (id) {
    const resolved = await resolveGateId(ctx, id)
    if (resolved && "error" in resolved) return { ok: false, kind: "message", message: resolved.error.message, variant: "warning" }
    if (resolved) id = resolved.id
    for (const from of tiers.flat()) {
      const t = await findByIdIn($, directory, config.tasksDir, from, id)
      if (t) return { ok: true, id, from }
    }
    const elsewhere = await findAnyStatus(ctx, id)
    const where = elsewhere ? statusFolder(elsewhere) : null
    // A forward status means the move already happened — informational, not an error.
    const variant: GateVariant = where && FORWARD_STATUSES.includes(where as TaskStatus) ? "info" : "warning"
    const message = where ? `"${id}" is in ${where} — nothing to do.` : ((await unparseableAt(ctx, id)) ?? `No task "${id}" found.`)
    return { ok: false, kind: "message", message, variant }
  }
  for (const tier of tiers) {
    const found: GateCandidate[] = []
    for (const from of tier) {
      for (const t of await listByStatus(client, directory, config.tasksDir, from, log)) {
        if (!skip?.(t)) found.push(toCandidate(t, from))
      }
    }
    if (found.length === 1) return { ok: true, id: found[0]!.id, from: found[0]!.from }
    if (found.length > 1) {
      // Ordered by FOLDER first, then the way a human must approve a stacked
      // slice set — lowest `priority` first, ties by id. The folder rank matters
      // because the first tier mixes two different gates: a priority-only sort
      // let a low-numbered `in-review` task — whose approval SHIPS it (push +
      // PR) — sort ahead of a `plan-review` plan and become the first option a
      // host offers. Priority sequences slices within a gate; it must never
      // reorder a ship gate ahead of a plan gate.
      const candidates = [...found].sort((a, b) => tier.indexOf(a.from) - tier.indexOf(b.from) || a.priority - b.priority || a.id.localeCompare(b.id))
      const list = candidates.map((c) => `${c.id} (${c.from})`).join(", ")
      // The message is pinned by tests and by both hosts' toasts. Widen `data`,
      // never this sentence.
      return { ok: false, kind: "message", message: `Multiple tasks awaiting: ${list} — pass an id.`, variant: "warning", candidates }
    }
  }
  return { ok: false, kind: "none" }
}

/**
 * The canonical id behind an explicit query that names a task already sitting
 * in `status`, or null — for anything else, including an empty query.
 *
 * Resolves through `resolveGateId` first so a short-hash handle works here
 * exactly as it does at every other gate; an ambiguous one resolves to nothing
 * and falls through to the ordinary refusal, which is the one that can explain
 * itself.
 */
const resolvedTaskIn = async (ctx: GateCtx, id: string, status: TaskStatus): Promise<string | null> => {
  if (!id) return null
  const resolved = await resolveGateId(ctx, id)
  if (!resolved || "error" in resolved) return null
  const t = await findByIdIn(ctx.$, ctx.directory, ctx.config.tasksDir, status, resolved.id)
  return t ? resolved.id : null
}

/** The `completed/` instance of {@link resolvedTaskIn} — the publish-later lookup. */
const completedTaskFor = (ctx: GateCtx, id: string): Promise<string | null> => resolvedTaskIn(ctx, id, "completed")

/**
 * approve shortcut — the unified, folder-driven gate. With an explicit `id` it
 * advances that task by the gate its folder implies: draft/ → queued (task gate),
 * plan-review/ → in-progress (plan gate), or in-review/ → completed (ship).
 * Without an id it advances the single task at a loop wait-gate (plan-review/ or
 * in-review/); only when *nothing* waits at either does it fall back to draft/.
 * The loop's own gates always outrank the authoring gate, so a parked plan is
 * never shadowed by a pile of drafts. Tracking epics are skipped in the id-less
 * scan — they are never approvable, so they must not create a false ambiguity.
 */
export const approveAny = async (ctx: GateCtx, id: string, kind = "engineering", publish?: ShipPublish, base?: string, autoPlan?: boolean): Promise<GateResult> => {
  const tiers: readonly (readonly TaskStatus[])[] = [["plan-review", "in-review"], ["draft"]]
  const pick = await resolveGateTask(ctx, id, tiers, (t) => isEpicType(t.type))
  if (!pick.ok) {
    // Publish-later. A `push` or `local` ship completes the task without opening
    // a PR, and `shipTask`'s already-completed arm is what opens one afterwards.
    //
    // Two conditions, and both are load-bearing:
    //
    //  - An EXPLICIT id. The id-less form must never look in `completed/`: it is
    //    a finished pile, not a gate queue, and picking from it would turn a bare
    //    `approve` — the form a human types when they mean "whatever is waiting"
    //    — into a re-ship of something they finished weeks ago.
    //  - An EXPLICIT publish choice. Without one this stays what it has always
    //    been: a report that the task already moved, which moves nothing. The
    //    publish step is not free — it pushes a branch — so a bare `approve` on a
    //    finished task must not acquire a network side effect it never had. The
    //    flag IS the request, and `workflow_ship`'s own retry arm (crash
    //    recovery) is unaffected either way.
    if (publish) {
      const donePublish = await completedTaskFor(ctx, id)
      if (donePublish) return shipTask(ctx, donePublish, kind, publish, base)
    }
    // A retry naming a task that has since moved ONE status past this gate's
    // own tiers still owns a task-specific alreadyDone arm — `approveTask` for
    // one already `queued/` (approved once), `approvePlan` for one already
    // `in-progress/` (its plan approved once). Falling through to
    // `resolveGateTask`'s generic "nothing to do" message here would drop
    // `data.gate`/`next` and the epic-slice continuation those arms carry, and
    // report `ok:false` for what is actually a harmless retry.
    const queuedRetry = await resolvedTaskIn(ctx, id, "queued")
    if (queuedRetry) return approveTask(ctx, queuedRetry, autoPlan)
    const inProgressRetry = await resolvedTaskIn(ctx, id, "in-progress")
    if (inProgressRetry) return approvePlan(ctx, inProgressRetry)
    if (pick.kind === "none") return { ok: false, message: "Nothing awaiting approval.", variant: "info" }
    // The ambiguity is the one refusal a host may act on rather than merely
    // report: NOTHING moved here (`resolveGateTask` only lists), so handing the
    // turn back to ask which task was meant cannot double-move anything, and the
    // answer is a FIRST approve on an id the human picked. `ambiguous`/`verb`
    // name the situation so a host branches on the payload, never on the prose.
    return {
      ok: false,
      message: pick.message,
      variant: pick.variant,
      ...(pick.candidates ? { data: { ambiguous: true, verb: "approve", candidates: pick.candidates } } : {}),
    }
  }
  if (pick.from === "draft") return approveTask(ctx, pick.id, autoPlan)
  if (pick.from === "plan-review") return approvePlan(ctx, pick.id)
  return shipTask(ctx, pick.id, kind, publish, base) // in-review
}

/** ship shortcut: id optional — ships the single in-review/ task when omitted. */
export const shipAny = async (ctx: GateCtx, id: string, kind = "engineering", publish?: ShipPublish, base?: string): Promise<GateResult> => {
  if (id) return shipTask(ctx, id, kind, publish, base)
  const pick = await resolveGateTask(ctx, "", [["in-review"]])
  if (!pick.ok) {
    return pick.kind === "none" ? { ok: false, message: "Nothing awaiting ship.", variant: "info" } : { ok: false, message: pick.message, variant: pick.variant }
  }
  return shipTask(ctx, pick.id, kind, publish, base)
}

/**
 * The folders whose task `rejectAny`'s leading token may name, in the order they
 * are tried. `plan-review` and `in-progress` are what `replan` acts on;
 * `queued` reaches `replanQueued`, the retry arm — a task rejected once is
 * already back in `queued/`, and it is the single likeliest thing a human names
 * a second time.
 *
 * Every other folder is here to REFUSE rather than to act: `replanTask` names
 * the wrong folder, which is the whole point. Before this, a token that resolved
 * in none of the two rejectable folders fell through to the id-less pick, so
 * `replan <queued-id> <why>` rejected an UNRELATED parked plan and folded the
 * id the human typed into its reason — silently, with every message naming the
 * task they had not asked about, and on OpenCode with an immediate re-plan of it.
 * Same defect as the short-hash bug the test at gate.test.ts:753 pins, one
 * folder over; the fix is the same rule taken to its end — a token that names a
 * real task is an id, never a reason word.
 */
const REJECT_ID_FOLDERS: readonly TaskStatus[] = ["plan-review", "in-progress", "queued", "draft", "in-review", "completed", "abandoned"]

/**
 * reject shortcut: send a parked plan back to queued/ for re-planning. Auto-targets
 * the single plan-review/ task; an explicit leading id may also name a cap-tripped
 * in-progress/ task or an already-queued one (the retry arm), with the rest of
 * `arg` as the reason. When no leading token names a task AT ALL, the whole `arg`
 * is the reason.
 */
export const rejectAny = async (ctx: GateCtx, arg: string): Promise<GateResult> => {
  const { $, directory, config, log } = ctx
  const [first = "", ...restParts] = arg.trim().split(/\s+/).filter(Boolean)
  if (first) {
    // Resolve the leading token as a task id the same way `approve` does — so the
    // short-hash handle the UIs surface (`f7k3`) targets the task instead of being
    // silently folded into the rejection reason. A hash that matches several tasks
    // in one folder is an ambiguity to surface, not a reason word.
    //
    // The cost of the wider scan is that a reason word which happens to prefix a
    // real task id is now claimed as an id in more folders. That trade is already
    // made for two folders, and it fails LOUDLY (a wrong-folder refusal naming the
    // task it matched, or a rejection of the task the human addressed) where the
    // fall-through failed silently on a different task. The id-less form —
    // `replan <reason…>` with no token matching anything — is untouched.
    for (const from of REJECT_ID_FOLDERS) {
      const r = await resolveTaskIdIn($, directory, config.tasksDir, from, first, log)
      if (r && "id" in r) return replanTask(ctx, r.id, restParts.join(" ").trim() || undefined)
      if (r && "ambiguous" in r) {
        return { ok: false, message: `Ambiguous id "${first}" — matches ${r.ambiguous.join(", ")}. Use more characters.`, variant: "warning" }
      }
    }
  }
  const pick = await resolveGateTask(ctx, "", [["plan-review"]])
  if (!pick.ok) {
    return pick.kind === "none" ? { ok: false, message: "No plan awaiting rejection.", variant: "info" } : { ok: false, message: pick.message, variant: pick.variant }
  }
  return replanTask(ctx, pick.id, arg.trim() || undefined)
}
