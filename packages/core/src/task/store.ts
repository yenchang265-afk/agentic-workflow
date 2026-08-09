import path from "node:path"
import { acquireMarker, acquireOrSweepMarker, markerOlderThan, releaseMarker, releaseMarkerIfStale, restampMarker, STALE_CLAIM_MINUTES } from "../claim-marker.js"
import { appendFileChunked, writeFileAtomic } from "../fsatomic.js"
import type { Client, Log, Shell } from "../host.js"
import { AUDIT_NOTE_LINE_RE, auditTailIndex, lastMarkerIndex, PLAN_HEADING } from "./plan-section.js"
import { revokePlanRequestAt, strayPlanRequestIds } from "./plan-request.js"
import { redact } from "./redact.js"
import { buildTaskFile, isPaired, isSafeTaskId, parseTask, serializeTask, SHORT_ID_RE, shortIdOf, type Task, type TaskInput } from "./schema.js"

export { PLAN_HEADING } from "./plan-section.js"

/**
 * Filesystem IO for the task backlog. **Impure**: reads via the host client
 * and moves files via the host shell (`$`), since the SDK has no file-write/move.
 * The folder a file lives in is its status; moves are how the driver advances a
 * task through its lifecycle.
 */

/** Anything with an id + on-disk path can be moved or annotated. */
type FileRef = { readonly id: string; readonly path: string }

export { STATUSES, type TaskStatus } from "./statuses.js"
import { STATUSES, type TaskStatus } from "./statuses.js"

const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md")

/** All tasks in claim order: lowest priority number first, ties broken by id. Pure. */
export const selectOrder = (tasks: readonly Task[]): Task[] =>
  [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

/** Pick the next task: lowest priority number, ties broken by id. Pure. */
export const selectNext = (tasks: readonly Task[]): Task | null => selectOrder(tasks)[0] ?? null

/**
 * The audited note a host appends to the task file — on the human-visible
 * branch, BEFORE cutting the isolation branch — the moment a claim wins.
 * Isolation commits everything else (BUILD notes, run logs, the done-path
 * move) onto `feature/<id>`, so after teardown the human branch's task file
 * would otherwise look untouched and the watcher would re-claim a task whose
 * work already ran. This marker is the durable "work happened" evidence that
 * survives on the human branch.
 */
export const CLAIMED_MARKER = "> CLAIMED"

/** Append the durable claim note (see `CLAIMED_MARKER`). Call while the tree is still on the human branch. */
export const markClaimed = async ($: Shell, task: FileRef, actor?: string | null, log?: Log): Promise<void> => {
  await appendNote($, task, auditNote("CLAIMED — loop starting", new Date(), actor), log)
}

/**
 * The audited note `approvePlan` appends at the plan gate — the start of a
 * task's CURRENT build lifecycle. Audit notes are append-only and survive a
 * replan, so the claimability predicates below must only read CLAIMED/BUILD
 * markers appended AFTER the most recent approval: an older attempt's notes
 * are history, not state. Without this, a task that built once and was
 * replanned reads "already started" forever — an approved plan no watcher
 * will ever claim.
 */
export const PLAN_APPROVED_MARKER = "> Plan approved"

/**
 * The audited note `replanTask` appends when a human rejects a plan (or a
 * capped run is sent back). The rejection reason rides on this line, and
 * `extractReplanReason` parses it back so the next PLAN pass receives it as a
 * structured prompt section instead of being told to dig through audit notes.
 */
export const PLAN_REJECTED_MARKER = "> Plan rejected"

/**
 * The audit note `runPark` appends when a plan lands and parks successfully.
 * This is the retirement anchor for `extractReplanReason`: PLAN replaces its
 * `## Implementation Plan` section IN PLACE (the stage prompt demands it, to
 * stop the body growing a heading per replan), so the heading's byte offset
 * never advances past a rejection note — "note newer than heading" would leave
 * every reason pending forever. "Note older than the last successful park" is
 * the invariant that survives in-place replacement.
 */
export const PLAN_WRITTEN_MARKER = "> Plan written"

/**
 * The one formatter for a plan-rejection audit note. `extractReplanReason`
 * parses this exact shape back (marker + reason prefix); a second hand-built
 * copy of the string is how a writer and the parser drift apart — the plan
 * contract's park refusal wrote a free-form note for a while, and the retry
 * PLAN pass never learned why it was refused.
 */
export const planRejectedNote = (reason?: string): string => {
  const flat = reason?.trim()
  return `Plan rejected — sent back to queued for re-planning${flat ? ` — ${flat}` : ""}`
}

/** Whether `marker` appears as an audit-note line (see `lastMarkerIndex`). Pure. */
const hasMarkerLine = (body: string, marker: string): boolean => lastMarkerIndex(body, marker) !== -1

/** The body of the task's current lifecycle: everything after the last
 *  plan-approval note; the whole body when none exists (legacy tasks). Pure. */
const lifecycleWindow = (body: string): string => {
  const idx = lastMarkerIndex(body, PLAN_APPROVED_MARKER)
  return idx === -1 ? body : body.slice(idx)
}

/**
 * Eligible for `/agentic-workflow:engineering watch` to claim: planned, with no
 * "> BUILD started" or CLAIMED note in the current lifecycle window — not just
 * "last pair unmatched" (that's `wasInterrupted`, below). A marker in the
 * window means another live WorkflowState is driving it right now, or it crashed
 * and needs manual recovery — a watch session must never silently reclaim
 * either case. Pure.
 */
export const isClaimable = (task: Task): boolean =>
  isReleasableClaim(task) && !hasMarkerLine(lifecycleWindow(task.body), CLAIMED_MARKER)

/**
 * The claim on this task may be handed back by the claimer that took it: the
 * current lifecycle never recorded a `> BUILD started` note, so no durable work
 * happened and dropping the marker cannot strand a partial build.
 *
 * Deliberately does NOT test for the CLAIMED note the way `isClaimable` does.
 * A claimer appends CLAIMED itself before it establishes isolation, so gating
 * its own release on `isClaimable` would make every release a no-op and wedge
 * the marker forever. This is only for a claimer releasing ITS OWN claim —
 * the orphan sweep stays gated on `isClaimable` on purpose (see
 * `isOrphanedClaim`), so it can never yank the marker out from under a live
 * run; that case is recovered by hand via `recover <id>`. Pure.
 */
export const isReleasableClaim = (task: Task): boolean =>
  hasPlan(task) && !hasMarkerLine(lifecycleWindow(task.body), "> BUILD started")

/**
 * The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure.
 *
 * Reads the LAST heading, not the first: `rejectPlan` only appends a note, so a
 * replanned task carries every superseded plan and the first heading is the stale
 * one. Stops at the audit tail rather than running to end-of-body: `appendNote`
 * and `appendPlan` both append at EOF, so a slice to the end accretes every
 * CLAIMED/BUILD/verdict note into `artifacts.plan` — monotonically, across every
 * iteration and every prior run.
 */
export const extractPlan = (task: Task): string | undefined => {
  const idx = lastMarkerIndex(task.body, PLAN_HEADING)
  if (idx === -1) return undefined
  const from = idx + PLAN_HEADING.length
  return task.body.slice(from, auditTailIndex(task.body, from)).trim()
}

/** The fixed prose between `PLAN_REJECTED_MARKER` and the reason on a rejection note. */
const PLAN_REJECTED_REASON_PREFIX = "— sent back to queued for re-planning — "

/**
 * The audited note `runDone` appends when a run's REVIEW passes and the task
 * parks in `in-review/`, and the fixed prose that carries the branch its work
 * landed on.
 *
 * The branch has to be recorded on the TASK FILE because nothing else survives
 * to the ship gate: the state snapshot is cleared by `runDone` itself, and
 * `shipTask` runs later, from a fresh process that receives only an id. Deriving
 * the branch from config at ship time is a guess — wrong in current-branch mode
 * (`taskBranch: false`, where no id→branch function can exist) and wrong in any
 * mode if the prefix changed between the run and the ship.
 */
export const RUN_DONE_MARKER = "> Loop done"
const RUN_BRANCH_PREFIX = "— review passed on branch "

/**
 * The branch the last completed run built on, or `undefined`. Pure.
 *
 * Reads the LAST `RUN_DONE_MARKER` line — a replanned-and-rebuilt task carries
 * one per run and only the newest names the branch that holds the work — and
 * requires `AUDIT_NOTE_LINE_RE`'s closing stamp, so a plan or a comment merely
 * quoting the line cannot inject a branch name into `git push`.
 */
export const extractRunBranch = (task: Task): string | undefined => {
  const idx = lastMarkerIndex(task.body, RUN_DONE_MARKER)
  if (idx === -1) return undefined
  const end = task.body.indexOf("\n", idx)
  const line = task.body.slice(idx, end === -1 ? task.body.length : end)
  if (!AUDIT_NOTE_LINE_RE.test(line)) return undefined
  const from = line.indexOf(RUN_BRANCH_PREFIX)
  if (from === -1) return undefined
  const branch = line
    .slice(from + RUN_BRANCH_PREFIX.length)
    .replace(/\s*\[[^\]\n]+\]\s*$/, "")
    .split(",")[0]
    ?.trim()
  // A ref name, never free text: this reaches `git push`, and the note's prose
  // is model-adjacent (an actor string rides on the same line).
  return branch && /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(branch) ? branch : undefined
}

/**
 * The PENDING rejection reason a human gave `replan` (or the plan contract's
 * park refusal recorded), or `undefined`. Pure.
 *
 * Reads the LAST `PLAN_REJECTED_MARKER` line, and only honors it when it comes
 * AFTER the rejection was last ADDRESSED — the later of the last `PLAN_HEADING`
 * and the last `PLAN_WRITTEN_MARKER` note. The heading alone was the old
 * anchor, and it silently broke when plan.md started demanding REPLACE-in-place
 * (the heading's offset never moves past the note, so every reason stayed
 * pending and leaked into unrelated later PLAN passes). A successful park
 * appends the `Plan written` note after the rejection, which retires it
 * whatever the writer did to the heading; legacy tasks with no such note keep
 * the heading comparison via the max. The line must carry
 * `AUDIT_NOTE_LINE_RE`'s closing stamp, so a plan merely quoting a rejection
 * line cannot inject a reason.
 */
export const extractReplanReason = (task: Task): string | undefined => {
  const idx = lastMarkerIndex(task.body, PLAN_REJECTED_MARKER)
  const addressed = Math.max(lastMarkerIndex(task.body, PLAN_HEADING), lastMarkerIndex(task.body, PLAN_WRITTEN_MARKER))
  if (idx === -1 || idx < addressed) return undefined
  const end = task.body.indexOf("\n", idx)
  const line = task.body.slice(idx, end === -1 ? task.body.length : end)
  if (!AUDIT_NOTE_LINE_RE.test(line)) return undefined
  const from = line.indexOf(PLAN_REJECTED_REASON_PREFIX)
  if (from === -1) return undefined
  const reason = line
    .slice(from + PLAN_REJECTED_REASON_PREFIX.length)
    .replace(/\s*\[[^\]\n]+\]\s*$/, "")
    .trim()
  return reason || undefined
}

/**
 * How many line-anchored `PLAN_HEADING`s the body carries. Pure.
 *
 * More than one means a PLAN pass stacked a new plan below an older one instead
 * of replacing it — the shape a task sent back by `replan` invites, since
 * `replanTask` moves the file without clearing its plan. Nothing breaks:
 * `extractPlan` reads the LAST heading, so the run uses the right plan. What is
 * lost is quieter — the superseded text stays in `splitTaskBody`'s `prose`, so
 * it rides along in `taskGoal` and in the hub's task editor from then on.
 *
 * Exists so `runPark` can WARN on it rather than trust the stage prompt's
 * replace instruction, which nothing else verifies. Counting shares
 * `lastMarkerIndex`'s anchoring on purpose: a second heading-matcher here could
 * drift from the one `extractPlan` and `hasPlan` agree on.
 */
export const planHeadingCount = (body: string): number => {
  // Single forward pass with the same line-anchoring rule as `lastMarkerIndex`
  // — the previous slice-per-hit reverse walk was O(k·n) with an allocation per
  // heading, and k is exactly what grows when PLAN stacks instead of replacing.
  let count = 0
  for (let idx = body.indexOf(PLAN_HEADING); idx !== -1; idx = body.indexOf(PLAN_HEADING, idx + 1)) {
    if (idx === 0 || body[idx - 1] === "\n") count++
  }
  return count
}

/**
 * How many stamped `PLAN_REJECTED_MARKER` notes sit after the last successful
 * park (`PLAN_WRITTEN_MARKER`) — i.e. rejections no plan has yet answered.
 * Consecutive counts here mean the planner is looping on the same refusal: the
 * park gate uses it to stop-for-human instead of burning a PLAN run per poll
 * tick forever. Only lines with `AUDIT_NOTE_LINE_RE`'s closing stamp count, so
 * quoted rejection text cannot inflate the tally. Pure.
 */
export const unaddressedRejectionCount = (body: string): number => {
  const addressed = lastMarkerIndex(body, PLAN_WRITTEN_MARKER)
  let count = 0
  for (let idx = body.indexOf(PLAN_REJECTED_MARKER); idx !== -1; idx = body.indexOf(PLAN_REJECTED_MARKER, idx + 1)) {
    if (idx !== 0 && body[idx - 1] !== "\n") continue
    if (idx < addressed) continue
    const end = body.indexOf("\n", idx)
    const line = body.slice(idx, end === -1 ? body.length : end)
    if (AUDIT_NOTE_LINE_RE.test(line)) count++
  }
  return count
}

/**
 * Whether a task has a plan persisted (appended at a prior approval gate). Pure.
 *
 * Defined AS `extractPlan` rather than as its own substring test, because the
 * two must not be able to disagree: `hasPlan` gates the PLAN park validator
 * (`runPark`), the plan-approval gate, and `isClaimable`, while `extractPlan` is
 * what actually fills `artifacts.plan` for BUILD. A body that satisfied only the
 * former sailed through all three gates and then fired BUILD with the whole
 * `{{#artifacts.plan}}` section dropped — the plan-less build the park validator
 * exists to prevent, with nothing reporting it.
 *
 * Two ways they used to diverge, both closed by this definition:
 *  - `includes` matched the heading MID-LINE, so a task merely *quoting*
 *    `## Implementation Plan` (this repo's backlog is full of tasks about the
 *    loop) read as planned; `extractPlan` is line-anchored via `lastMarkerIndex`.
 *  - A heading with nothing under it read as planned, while `extractPlan`
 *    returned `""` — falsy at the one call site that matters
 *    (`entryState`'s `plan ? { plan } : {}`).
 */
export const hasPlan = (task: Task): boolean => !!extractPlan(task)

/** A task body split into the prose a human may edit and the audit trail that must survive. */
export interface TaskBodyParts {
  /** Editable prose, trimmed. `""` for a body that is nothing but notes. */
  readonly prose: string
  /** The trailing `> …` run, verbatim and trimmed. `""` when there is none. */
  readonly tail: string
}

/** A line that may belong to the trailing audit run: blank, or a `> ` blockquote. */
const isTailLine = (line: string): boolean => line.trim() === "" || /^>(\s|$)/.test(line)

/**
 * Split a task body into the prose a human may edit and the audit tail that must
 * survive the edit.
 *
 * `appendNote` only ever APPENDS `> …` lines, so a task's audit trail is the
 * maximal suffix of blockquote-and-blank lines. That is the whole rule — purely
 * positional, with no attempt to recognise a note by its text (the format is
 * `auditNote`'s, and matching on it here would be a second parser that can
 * drift). A blockquote a human wrote in the MIDDLE of the body stays in `prose`,
 * exactly where it is; one they wrote at the very END is conservatively classed
 * as tail, so it becomes read-only rather than editable. The bias runs that way
 * on purpose: losing the ability to edit one line is recoverable, losing an
 * audit note is not.
 *
 * Deliberately NOT plan-aware — `PLAN_HEADING` and its text land in `prose`,
 * which is why a caller offering an editor gates on `hasPlan` first. Pure.
 */
export const splitTaskBody = (body: string): TaskBodyParts => {
  const lines = body.split("\n")
  let cut = lines.length
  while (cut > 0 && isTailLine(lines[cut - 1]!)) cut--
  return {
    prose: lines.slice(0, cut).join("\n").trim(),
    tail: lines.slice(cut).join("\n").trim(),
  }
}

/** Rejoin the halves into a task body — the inverse of `splitTaskBody`. Pure. */
export const joinTaskBody = (prose: string, tail: string): string => {
  const p = prose.trim()
  const t = tail.trim()
  return p && t ? `${p}\n\n${t}` : p || t
}

/**
 * Planned and started at least once in the current lifecycle window — no longer
 * claimable by `/agentic-workflow:engineering watch`, but a human can force-resume it
 * with `/agentic-workflow:engineering recover <id>` once no live loop is driving it
 * (crashed runs, restarted plugins). Pure.
 */
export const isRecoverable = (task: Task): boolean => {
  const window = lifecycleWindow(task.body)
  return hasPlan(task) && (hasMarkerLine(window, "> BUILD started") || hasMarkerLine(window, CLAIMED_MARKER))
}

/**
 * Whether the current lifecycle's last recorded BUILD run has no matching
 * "finished" note — i.e. the process likely died mid-build, possibly leaving a
 * half-finished diff in the working tree. Only BUILD is tracked: it's the sole
 * stage that writes code. A pre-replan attempt's unmatched note must not keep
 * flagging a freshly re-approved task, hence the window. Pure.
 */
export const wasInterrupted = (task: Task): boolean => {
  const window = lifecycleWindow(task.body)
  const lastStart = lastMarkerIndex(window, "> BUILD started")
  if (lastStart === -1) return false
  const lastFinish = lastMarkerIndex(window, "> BUILD finished")
  return lastFinish < lastStart
}

/** A per-status roll-up of the backlog for `/agentic-workflow:engineering status`. Pure. */
export interface BacklogSummary {
  readonly counts: Readonly<Record<TaskStatus, number>>
  /** draft tasks awaiting the human task gate (/agentic-workflow:engineering approve) — tracking epics excluded, they are never approved. */
  readonly awaitingTask: readonly string[]
  /** queued tasks awaiting the loop's PLAN stage (a watcher will claim them once no build work remains). */
  readonly awaitingPlan: readonly string[]
  /** plan-review tasks whose plan is parked for human review (/agentic-workflow:engineering approve). */
  readonly gated: readonly string[]
  /** in-progress tasks parked and never started (a watcher will claim them). */
  readonly claimable: readonly string[]
  /** in-progress tasks whose body is claimable but whose claim marker is currently held. */
  readonly claimHeld: readonly string[]
  /** in-progress tasks whose last build looks interrupted (crashed — /agentic-workflow:engineering recover). */
  readonly interrupted: readonly string[]
  /** in-review tasks awaiting a human diff review (/agentic-workflow:engineering approve). */
  readonly awaitingReview: readonly string[]
}

/**
 * Roll up tasks-by-status into counts and actionable flag lists. `claimedIds`
 * (ids holding a claim marker, see `listClaimIds`) splits body-claimable tasks
 * into truly claimable vs claim-held, so status never reports a task "ready"
 * that no watcher can actually claim. Pure.
 */
export const summarizeBacklog = (
  byStatus: Readonly<Record<TaskStatus, readonly Task[]>>,
  claimedIds: readonly string[] = [],
): BacklogSummary => {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, byStatus[s]?.length ?? 0])) as Record<TaskStatus, number>
  const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id)
  const inProgress = byStatus["in-progress"] ?? []
  const held = new Set(claimedIds)
  return {
    counts,
    awaitingTask: ids((byStatus["draft"] ?? []).filter((t) => t.type !== "epic")),
    awaitingPlan: ids(byStatus["queued"] ?? []),
    gated: ids((byStatus["plan-review"] ?? []).filter(hasPlan)),
    claimable: ids(inProgress.filter((t) => isClaimable(t) && !held.has(t.id))),
    claimHeld: ids(inProgress.filter((t) => isClaimable(t) && held.has(t.id))),
    interrupted: ids(inProgress.filter(wasInterrupted)),
    awaitingReview: ids(byStatus["in-review"] ?? []),
  }
}

/** The active statuses whose tasks ought to be paired to a tracker item. */
const ACTIVE_STATUSES: readonly TaskStatus[] = ["draft", "queued", "plan-review", "in-progress", "in-review"]

/**
 * Pairing coverage across the active backlog (everything but completed/abandoned):
 * how many active tasks carry a `tracker` block vs the ids of those that don't.
 * Feeds the `workflow_status` pairing view when project management is configured. Pure.
 */
export const pairingCoverage = (
  byStatus: Readonly<Record<TaskStatus, readonly Task[]>>,
): { readonly paired: number; readonly unpaired: readonly string[] } => {
  const active = ACTIVE_STATUSES.flatMap((s) => byStatus[s] ?? [])
  const paired = active.filter(isPaired).length
  const unpaired = active.filter((t) => !isPaired(t)).map((t) => t.id).sort((a, b) => a.localeCompare(b))
  return { paired, unpaired }
}

/**
 * List and parse every task in a given status folder. Invalid files are
 * skipped (logged) rather than failing the whole pick. Returns `[]` when the
 * folder is absent.
 */
export const listByStatus = async (
  client: Client,
  directory: string,
  tasksDir: string,
  status: string, // read-side: any status folder a kind's manifest declares
  log?: Log,
): Promise<Task[]> => {
  const dir = `${tasksDir}/${status}`
  let nodes
  try {
    const res = await client.file.list({ query: { path: dir, directory } })
    nodes = res.data ?? []
  } catch {
    return [] // folder absent / not yet created
  }

  const tasks: Task[] = []
  for (const node of nodes) {
    if (node.type !== "file" || !isMarkdown(node.name)) continue
    const read = await client.file.read({ query: { path: node.path, directory } })
    const content = read.data?.content
    if (!content) {
      // Never a SILENT skip: an empty task file is otherwise a perfect ghost —
      // present in the folder, invisible to every listing, claim walk, and gate
      // verb, squatting on its id. Doctor reports it too (auditBacklog
      // `emptyFiles`); this line is the trace for a caller that passed a log.
      log?.("warn", `skipping ${node.path}: empty or unreadable task file`)
      continue
    }
    try {
      tasks.push(parseTask(node.name, content, node.absolute))
    } catch (err) {
      log?.("warn", `skipping ${node.path}: ${(err as Error).message}`)
    }
  }
  return tasks
}

/** List and parse every task in `queued/` — approved, awaiting the loop's PLAN stage. */
export const listQueued = (client: Client, directory: string, tasksDir: string, log?: Log): Promise<Task[]> =>
  listByStatus(client, directory, tasksDir, "queued", log)

/** List and parse every task in `in-progress/` — the pool `/agentic-workflow:engineering watch` claims from. */
export const listInProgress = (client: Client, directory: string, tasksDir: string, log?: Log): Promise<Task[]> =>
  listByStatus(client, directory, tasksDir, "in-progress", log)

/**
 * Resolve a specific task by id within a status folder, or null if missing/invalid.
 *
 * Reads the REAL filesystem through the shell (`$ cat <abs path>`), NOT the host
 * client. On opencode the file client is served by a watcher-backed index that lags
 * the real FS after a shell `mv` (see `moveTask`), and it resolves a hand-built
 * relative read path differently from a listed one — so right after the loop moves a
 * task into a folder, a client-based lookup can read the plainly-present file back as
 * missing and every gate toasts "no task found". The shell has neither problem: it
 * operates on the real absolute path, exactly as `moveTask`/`claimTask` already do.
 * Hand-building `<id>.md` is safe HERE because it goes to the shell, not the client.
 *
 * Only ever called on human-triggered / one-off / loop-terminal paths (gates, replan,
 * ship, recover, start, findAnyStatus), never per-poll — the scheduler enumerates
 * unknown ids via `listByStatus` and tolerates lag by retrying each tick — so one
 * `cat` per call is free.
 */
export const findByIdIn = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  status: string, // read-side: any status folder a kind's manifest declares
  id: string,
  log?: Log,
): Promise<Task | null> => {
  // Ids reach `path.join` here, so an unsafe one (`../…`) would escape the
  // backlog — reject before any fs use rather than trusting the caller.
  if (!isSafeTaskId(id)) {
    log?.("warn", `rejecting unsafe task id ${JSON.stringify(id)}`)
    return null
  }
  const filename = `${id}.md`
  const file = path.join(directory, tasksDir, status, filename)
  const out = await $`cat ${file}`.quiet().nothrow()
  if (out.exitCode !== 0) return null // absent / unreadable on the real FS
  try {
    return parseTask(filename, out.stdout.toString(), file)
  } catch (err) {
    log?.("warn", `skipping ${file}: ${(err as Error).message}`)
    return null
  }
}

/** Outcome of resolving a user-typed id query: a hit, an ambiguity, or nothing. */
export type ResolvedId = { readonly id: string } | { readonly ambiguous: readonly string[] } | null

/**
 * Resolve a user-supplied `query` to a concrete task id in `status`, so a human can
 * target a task by its short-hash handle (`f7k3`) instead of the full
 * `f7k3-add-rate-limit` filename. Real-FS `ls`/`cat` through the shell for the same
 * lag-avoidance reason `findByIdIn` documents above.
 *
 * - Exact `<query>.md` present → that id (covers full modern ids AND legacy `<slug>.md`).
 * - Else among modern `<hash>-<slug>.md` files, those whose short hash starts with
 *   `query`: exactly one → resolve, several → ambiguous (never guesses).
 * - Nothing → null.
 */
export const resolveTaskIdIn = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  status: string,
  query: string,
  log?: Log,
): Promise<ResolvedId> => {
  if (!query) return null
  // The exact-match branch below would bless a `../…` query as a valid id and
  // feed it to every downstream path builder — reject unsafe queries outright.
  if (!isSafeTaskId(query)) {
    log?.("warn", `rejecting unsafe id query ${JSON.stringify(query)}`)
    return null
  }
  const dir = path.join(directory, tasksDir, status)
  // (a) exact filename — a full modern id, or a legacy slug id.
  const exact = await $`cat ${path.join(dir, `${query}.md`)}`.quiet().nothrow()
  if (exact.exitCode === 0) return { id: query }
  // (b) short-hash prefix among modern ids only.
  const ls = await $`ls ${dir}`.quiet().nothrow()
  if (ls.exitCode !== 0) return null
  const ids = ls.stdout
    .toString()
    .split("\n")
    .filter((n) => isMarkdown(n))
    .map((n) => n.replace(/\.md$/i, ""))
  // Match on the short-hash handle OR on a longer full-id prefix, so when two tasks
  // share a 4-char hash the human can actually disambiguate by typing more of the id
  // (`f7k3-add`) — the "Use more characters" advice the gate gives on ambiguity.
  const matches = ids.filter((id) => SHORT_ID_RE.test(id) && (shortIdOf(id).startsWith(query) || id.startsWith(query)))
  if (matches.length === 0) return null
  if (matches.length === 1) return { id: matches[0]! }
  log?.("info", `ambiguous id "${query}" — matches ${matches.join(", ")}`)
  return { ambiguous: [...matches].sort() }
}

/**
 * Resolve a user-typed id — possibly a short-hash handle (`f7k3`) rather than
 * the full `f7k3-add-rate-limit` filename — to the single canonical task id
 * across ALL status folders. An exact filename hit in any folder wins
 * immediately (full modern ids and legacy slugs); otherwise the short-hash
 * prefix matches from every folder are merged: exactly one → resolved, several
 * → ambiguous (never guesses), none → null. This is the resolution the gate
 * verbs (approve/replan) have always done — exported so every id-taking verb
 * (`plan`, `recover`, workflow_start) accepts the same short handles the UIs
 * surface as "the copyable id".
 */
export const resolveTaskIdAnywhere = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  query: string,
  log?: Log,
): Promise<ResolvedId> => {
  if (!query) return null
  const prefix = new Set<string>()
  for (const s of STATUSES) {
    const r = await resolveTaskIdIn($, directory, tasksDir, s, query, log)
    if (!r) continue
    if ("id" in r) {
      if (r.id === query) return { id: query } // exact filename (full id or legacy slug) wins immediately
      prefix.add(r.id)
    } else for (const m of r.ambiguous) prefix.add(m)
  }
  if (prefix.size === 1) return { id: [...prefix][0]! }
  if (prefix.size > 1) return { ambiguous: [...prefix].sort() }
  return null
}

/** Directory of atomic claim markers, alongside the task files of one status folder. */
const claimsDir = (taskPath: string): string => path.join(path.dirname(taskPath), ".claims")

/** A task's claim marker directory. The stamp/staleness rules live in `claim-marker.ts`. */
const claimMarker = (task: FileRef): string => path.join(claimsDir(task.path), task.id)

/**
 * Atomically claim a task for execution. Closes the window between listing
 * claimable tasks and appending the `> BUILD started` note. See
 * `claim-marker.ts` for why the marker carries a stamp.
 */
export const claimTask = ($: Shell, task: FileRef, now: Date = new Date()): Promise<boolean> => acquireMarker($, claimMarker(task), now)

/** Release a task's claim marker, if present. Best-effort; a wedged marker is
 *  logged when the caller passes a log (see `releaseMarker`). */
export const releaseClaim = ($: Shell, task: FileRef, log?: Log): Promise<void> => releaseMarker($, claimMarker(task), log)

/**
 * Claim a task, atomically sweeping a stale leftover marker first (rename-aside
 * — see `acquireOrSweepMarker`). `minutes: 0` is an unconditional takeover for
 * callers that have already established the holder is dead (e.g. `recover`
 * after the liveness checks). False when the marker is fresh or a rival won.
 */
export const claimTaskSweepingStale = ($: Shell, task: FileRef, minutes: number, now: Date = new Date()): Promise<boolean> =>
  acquireOrSweepMarker($, claimMarker(task), minutes, now)

/**
 * Refresh a held claim's stamp. Drivers call this at every stage boundary so a
 * live multi-stage run — which can legitimately outlive `staleClaimMinutes` —
 * never reads as a stale claim to another process's sweep. No-op when released.
 */
export const refreshClaimStamp = ($: Shell, task: FileRef, now: Date = new Date()): Promise<void> =>
  restampMarker($, claimMarker(task), now)

/**
 * The one restamp seam a driver calls at every stage boundary, whatever kind of
 * work it drives: a task-backed loop restamps through `refreshClaimStamp`; a
 * task-less (sitter) drive restamps the marker path its work source stamped
 * onto the state (`claimMarkerDir`, see `withClaimMarker`); a state with
 * neither is a no-op. One export, so a host cannot restamp tasks and forget
 * sitters — that asymmetry is exactly how sitter drives ran unstamped against
 * a 15-minute window and got double-driven.
 */
export const refreshWorkClaim = (
  $: Shell,
  state: { readonly task?: FileRef; readonly claimMarkerDir?: string },
  now: Date = new Date(),
): Promise<void> =>
  state.task ? refreshClaimStamp($, state.task, now) : state.claimMarkerDir ? restampMarker($, state.claimMarkerDir, now) : Promise.resolve()

/**
 * Whether a `FileRef`'s claim marker exists and is older than `minutes`.
 * On a task with no BUILD note and no live loop, that means orphaned — its
 * claimer died between `claimTask` and the first "BUILD started" note.
 */
export const claimOlderThan = ($: Shell, task: FileRef, minutes: number, now: Date = new Date()): Promise<boolean> =>
  markerOlderThan($, claimMarker(task), minutes, now)

export { STALE_CLAIM_MINUTES }

/** Ids currently holding a claim marker in a status folder's `.claims/`. `[]` when absent. */
export const listClaimIds = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  status: string = "in-progress", // read-side: any status folder a kind's manifest declares
): Promise<string[]> => {
  const dir = path.join(directory, tasksDir, status, ".claims")
  const out = await $`ls -1 ${dir}`.quiet().nothrow()
  if (out.exitCode !== 0) return []
  return (
    out.stdout
      .toString()
      .split("\n")
      .map((s) => s.trim())
      // Screened on the way out, like `listPlanRequestIds`: `.claims/` is a plain
      // directory anything can drop an entry into. The `.dead-` exclusion is not
      // covered by `isSafeTaskId` (dots are legal past the first character): it is
      // `acquireOrSweepMarker`'s rename-aside graveyard suffix, stranded forever by
      // a SIGKILL between the rename and the rm — listed, it reads as a held claim
      // no verb can ever release.
      .filter((s) => s.length > 0 && isSafeTaskId(s) && !s.includes(".dead-"))
  )
}

/**
 * The stray plan requests CONFIRMED absent from their pool on the real
 * filesystem — the only ids `revokeStrayPlanRequests` may be handed.
 * `presentIds` is the caller's listing of the folder, which may lag the real
 * FS (a watcher-backed index after a shell `mv`) and skips unparseable files —
 * so every apparent stray is re-checked with `findByIdIn` before it is named.
 * Without that, a request for a task the listing missed (just moved in, or
 * momentarily unparseable) is judged stray and a human's live ask is deleted.
 */
export const confirmedStrayPlanRequestIds = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  presentIds: readonly string[],
  status: string = "queued",
  log?: Log,
): Promise<string[]> => {
  const strays: string[] = []
  for (const id of await strayPlanRequestIds($, directory, tasksDir, presentIds, status)) {
    if (await findByIdIn($, directory, tasksDir, status, id, log)) continue
    strays.push(id)
  }
  return strays
}

/**
 * An orphaned claim: the task body never recorded a BUILD (still claimable),
 * no live loop is driving it, and the marker has aged past the crash window.
 * Only such markers may be released without racing a live claimer. Pure.
 */
export const isOrphanedClaim = (
  task: Task,
  opts: { readonly drivenByLiveWorkflow: boolean; readonly markerStale: boolean },
): boolean => isClaimable(task) && !opts.drivenByLiveWorkflow && opts.markerStale

/**
 * The `queued/` variant of `isOrphanedClaim`: a queued task is planless by
 * definition (no `isClaimable` gate applies) and its PLAN stage never writes
 * code, so a stale, undriven marker is always safe to release — a died PLAN
 * left at most a partial plan on the task file, which the next PLAN pass
 * overwrites. Pure.
 */
export const isOrphanedPlanClaim = (
  _task: Task,
  opts: { readonly drivenByLiveWorkflow: boolean; readonly markerStale: boolean },
): boolean => !opts.drivenByLiveWorkflow && opts.markerStale

/**
 * The backlog DOCTOR's orphan rule for started (`in-progress/`) tasks: a stale,
 * undriven marker is dead whatever the body says. Drivers restamp the claim at
 * every stage boundary and the doctor's window is stage-timeout-derived, so a
 * live loop can never read as stale here. The default `isOrphanedClaim` gates
 * on `isClaimable` — right for the automatic watcher sweep, but false forever
 * once the CLAIMED/BUILD notes land, which left a crashed run's marker
 * unreleasable by any verb: replan/abandon/remove refuse a held claim and point
 * at `doctor fix`, which (with the default rule) could not help either. Pure.
 */
export const isOrphanedStartedClaim = (
  _task: Task,
  opts: { readonly drivenByLiveWorkflow: boolean; readonly markerStale: boolean },
): boolean => !opts.drivenByLiveWorkflow && opts.markerStale

/** Result of walking the claim candidates: the winner, and the ids whose markers stayed held. */
export interface ClaimAttempt {
  readonly claimed: Task | null
  readonly heldIds: readonly string[]
}

/**
 * Try candidates (already in `selectOrder`) until one claim wins — a single
 * held marker must not block the tasks queued behind it. A failed claim whose
 * marker looks orphaned is released and retried ONCE; failing the retry means
 * another instance raced us — treat as held and move on.
 */
export const claimFirst = async (
  $: Shell,
  candidates: readonly Task[],
  opts: {
    readonly isDriving: (id: string) => boolean
    readonly staleMinutes?: number
    readonly log?: Log
    /** Orphan predicate — defaults to `isOrphanedClaim`; use `isOrphanedPlanClaim` for `queued/` candidates. */
    readonly isOrphaned?: typeof isOrphanedClaim
    /** Observability hook: called after an orphaned claim marker is released (stale takeover). Best-effort. */
    readonly onOrphanRelease?: (id: string) => Promise<void> | void
    /**
     * Re-read a just-claimed task from the REAL filesystem. The candidate list
     * may come from a lagging watcher index (see `listByStatus` vs `findByIdIn`):
     * a task whose run just finished can still be listed in its old folder with
     * a pre-CLAIMED body, and the marker `mkdir` wins because completion released
     * it — starting a redundant second run. Return the fresh Task to hand out, or
     * null to release the marker and skip the candidate (file moved away, or the
     * fresh body is no longer claimable).
     */
    readonly reverify?: (task: Task) => Promise<Task | null>
  },
): Promise<ClaimAttempt> => {
  const heldIds: string[] = []
  const isOrphaned = opts.isOrphaned ?? isOrphanedClaim
  // Confirm a claim win against the real FS; null means the listing was stale.
  const settle = async (task: Task): Promise<Task | null> => {
    if (!opts.reverify) return task
    const fresh = await opts.reverify(task)
    if (fresh) return fresh
    opts.log?.("warn", `dropping stale claim of ${task.id} — the listed file is gone or no longer claimable on the real filesystem`)
    await releaseClaim($, task)
    return null
  }
  for (const task of candidates) {
    if (await claimTask($, task)) {
      const fresh = await settle(task)
      if (fresh) return { claimed: fresh, heldIds }
      continue // stale listing, nothing holds it — not a held marker
    }
    const markerStale = await claimOlderThan($, task, opts.staleMinutes ?? STALE_CLAIM_MINUTES)
    if (isOrphaned(task, { drivenByLiveWorkflow: opts.isDriving(task.id), markerStale })) {
      opts.log?.("warn", `releasing orphaned claim marker for ${task.id} — its claimer died before the stage started`)
      // Atomic takeover (rename-aside): the plain `releaseClaim` + `claimTask`
      // it replaces let two pollers both judge the same stale marker, and the
      // slower one deleted the winner's brand-new claim — both then drove the
      // task. `acquireOrSweepMarker` re-judges staleness itself, so a rival's
      // fresh claim survives and this caller stands down.
      //
      // The takeover is now one operation, so the telemetry fires on the WIN
      // rather than on a bare release: a `claim-takeover` event means this
      // process really did take the marker over, never that it dropped someone
      // else's and then lost the re-claim.
      if (await claimTaskSweepingStale($, task, opts.staleMinutes ?? STALE_CLAIM_MINUTES)) {
        await opts.onOrphanRelease?.(task.id)
        const fresh = await settle(task)
        if (fresh) return { claimed: fresh, heldIds }
        continue
      }
    }
    heldIds.push(task.id)
  }
  return { claimed: null, heldIds }
}

/**
 * Startup sweep: release claim markers left behind by dead runs. Two shapes —
 * a marker whose task body is still claimable (crashed between `claimTask`
 * and the BUILD note), and a marker with no task file at all (crashed between
 * `moveTask`'s `mv` and `rmdir`). Both only when stale and not live-driven.
 * Returns the released ids.
 */
export const releaseOrphanedClaims = async (
  $: Shell,
  inProgress: readonly Task[],
  claimIds: readonly string[],
  inProgressDir: string,
  opts: {
    readonly isDriving: (id: string) => boolean
    readonly staleMinutes?: number
    /** Orphan predicate — defaults to `isOrphanedClaim`; use `isOrphanedPlanClaim` when sweeping `queued/`. */
    readonly isOrphaned?: typeof isOrphanedClaim
  },
): Promise<string[]> => {
  const byId = new Map(inProgress.map((t) => [t.id, t]))
  const isOrphaned = opts.isOrphaned ?? isOrphanedClaim
  const released: string[] = []
  for (const id of claimIds) {
    const task = byId.get(id)
    const ref: FileRef = task ?? { id, path: path.join(inProgressDir, `${id}.md`) }
    const markerStale = await claimOlderThan($, ref, opts.staleMinutes ?? STALE_CLAIM_MINUTES)
    const orphaned = task
      ? isOrphaned(task, { drivenByLiveWorkflow: opts.isDriving(id), markerStale })
      : markerStale && !opts.isDriving(id)
    if (!orphaned) continue
    // Atomic stale release (rename-aside): a plain `releaseClaim` here raced a
    // legitimate claimer that won the marker between this sweep's age check and
    // its `rmdir` — the sweep deleted the live claim and a second claimer took
    // the task. `releaseMarkerIfStale` re-judges what it moved aside, so only a
    // marker that is STILL stale at removal time counts as released.
    if (await releaseMarkerIfStale($, claimMarker(ref), opts.staleMinutes ?? STALE_CLAIM_MINUTES)) released.push(id)
  }
  return released
}

/** The forward lifecycle order (excludes `abandoned`, which is a cancellation escape, not a stage). */
const FORWARD_ORDER: readonly TaskStatus[] = ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"]

/**
 * Whether a task may move from `from` to `to`. Tasks advance exactly one
 * stage at a time — no skipping — with three escapes: any non-terminal stage
 * may be abandoned directly (cancellation isn't a forward skip); a
 * replan sends `plan-review` or `in-progress` back to `queued` (the plan was
 * rejected or the loop capped out — the PLAN stage runs again); and a retask
 * sends an approved-but-planless `queued` task back to `draft` for reshaping
 * (nothing downstream exists yet, and the stale approval must be re-taken).
 * `completed` and `abandoned` are terminal: nothing moves out of them. Pure.
 */
export const canTransition = (from: TaskStatus, to: TaskStatus): boolean => {
  if (from === "completed" || from === "abandoned") return false
  if (to === "abandoned") return true
  if (to === "queued" && (from === "plan-review" || from === "in-progress")) return true
  if (to === "draft" && from === "queued") return true
  const fromIdx = FORWARD_ORDER.indexOf(from)
  const toIdx = FORWARD_ORDER.indexOf(to)
  return fromIdx !== -1 && toIdx === fromIdx + 1
}

/** The status folder a task file currently lives in, derived from its path. */
export const statusOf = (task: FileRef): TaskStatus => {
  const status = path.basename(path.dirname(task.path))
  if (!STATUSES.includes(status as TaskStatus)) {
    throw new Error(`${task.path} is not inside a known status folder`)
  }
  return status as TaskStatus
}

/**
 * Move a task file into a new status folder. Returns its new absolute path.
 * Enforces the lifecycle order via `canTransition` — throws rather than
 * skipping a stage.
 */
export const moveTask = async ($: Shell, task: FileRef, toStatus: TaskStatus): Promise<string> => {
  // The destination is built from `task.id` — an unsafe id (`../…`) would
  // relocate the file outside the backlog. Callers pass ids from parsed
  // filenames, but this is the last write boundary, so enforce it here too.
  if (!isSafeTaskId(task.id)) {
    throw new Error(`cannot move task: unsafe id ${JSON.stringify(task.id)}`)
  }
  const fromStatus = statusOf(task)
  if (!canTransition(fromStatus, toStatus)) {
    throw new Error(`cannot move ${task.id} from ${fromStatus} to ${toStatus} — tasks must advance one stage at a time`)
  }
  const root = path.dirname(path.dirname(task.path)) // …/docs/tasks
  const destDir = path.join(root, toStatus)
  const dest = path.join(destDir, `${task.id}.md`)
  // Refuse to clobber a duplicate id (hand-authored drafts and audit-reported
  // duplicates are real states) — `mv` would silently destroy the other task's
  // file and audit trail. Mirrors rescueStray's guard.
  const exists = await $`test -e ${dest}`.quiet().nothrow()
  if (exists.exitCode === 0) {
    throw new Error(`cannot move ${task.id} → ${toStatus}: ${toStatus}/${task.id}.md already exists — resolve the duplicate manually`)
  }
  await $`mkdir -p ${destDir}`.quiet().nothrow()
  // `-n`, because the check above is a TOCTOU pair with this line: two gate verbs
  // racing (the hub and a host, or two hosts) can both find `dest` absent, and a
  // plain `mv` would let the second silently destroy the first task's file AND its
  // audit trail. `-n` makes the kernel arbitrate; the loser leaves the source in
  // place, which is what the post-check below detects.
  const out = await $`mv -n ${task.path} ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not move ${task.id} → ${toStatus}: ${out.stderr.toString().trim()}`)
  }
  // Confirm the file actually landed on the real FS — never let a caller report a
  // move that didn't happen (a stale `task.path` can make `mv` a silent no-op-ish).
  const check = await $`test -f ${dest}`.quiet().nothrow()
  if (check.exitCode !== 0) {
    throw new Error(`move of ${task.id} → ${toStatus} did not land at ${dest}`)
  }
  // `mv -n` onto an existing destination is a SUCCESSFUL no-op on GNU coreutils —
  // exit 0, source untouched — so `test -f dest` above passes on the file that was
  // already there. The source still existing is the only signal that we lost the
  // race, and reporting the move would hand the caller a path it does not own.
  const src = await $`test -e ${task.path}`.quiet().nothrow()
  if (src.exitCode === 0) {
    throw new Error(`cannot move ${task.id} → ${toStatus}: ${toStatus}/${task.id}.md was created concurrently — resolve the duplicate manually`)
  }
  await releaseClaim($, task) // a claim belongs to the status folder it was taken in
  // So does a plan request: left behind it is a stray at best, and at worst a
  // resurrected ordering hint — abandon then restore-to-queued/ would silently
  // re-honour an ask nobody re-made.
  await revokePlanRequestAt($, path.dirname(task.path), task.id)
  return dest
}

/**
 * Hard-delete a task file from its status folder. Unlike `moveTask` this does
 * not relocate the task — the file is removed outright, so the task leaves the
 * active backlog entirely (git history retains it if the backlog is tracked).
 *
 * The `isSafeTaskId` guard is the same last-write-boundary check `moveTask`
 * makes: an unsafe id (`../…`) would reach outside the backlog. Any held claim
 * marker is released first (its `.claims/<id>` dir would otherwise be orphaned),
 * then the file is removed and the removal confirmed on the real FS — a caller
 * must never be told a file is gone when a stale `task.path` made `rm` a no-op.
 * Returns the removed absolute path.
 */
export const removeTaskFile = async ($: Shell, task: FileRef): Promise<string> => {
  if (!isSafeTaskId(task.id)) {
    throw new Error(`cannot remove task: unsafe id ${JSON.stringify(task.id)}`)
  }
  await releaseClaim($, task) // drop the marker before the file it belongs to goes
  await revokePlanRequestAt($, path.dirname(task.path), task.id) // same for a plan request — nothing sweeps for a deleted task
  const out = await $`rm -f ${task.path}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not remove ${task.id}: ${out.stderr.toString().trim()}`)
  }
  const check = await $`test -e ${task.path}`.quiet().nothrow()
  if (check.exitCode === 0) {
    throw new Error(`removal of ${task.id} did not take effect at ${task.path}`)
  }
  return task.path
}

/**
 * Rewrite an EXISTING task file in place: same id, same filename, same status
 * folder.
 *
 * The counterweight to `writeTask` — that one CREATES and refuses to clobber;
 * this one UPDATES and refuses to create. Together they are total, and neither
 * can be talked into the other's job.
 *
 * It cannot move or rename by construction: there is no `TaskStatus` parameter
 * to express a move, the write target is DERIVED (`dirname(task.path)/<id>.md`)
 * rather than taken from the caller, and the derived path is asserted equal to
 * `task.path`. Lifecycle moves stay `moveTask`'s alone — it, not this, owns
 * `canTransition`.
 *
 * `input` is the WHOLE task, not a patch: `serializeTask` validates the entire
 * frontmatter, so a partial patch would have to be merged against the parsed
 * task anyway. The caller does that merge (`taskToInput` + spread), where it can
 * also decide which fields a human may touch. Serialization runs BEFORE any
 * write, so invalid frontmatter leaves the file byte-identical.
 *
 * Frontmatter keys the schema doesn't know are DROPPED (zod strips them). A
 * caller that must not lose them screens with `unknownFrontmatterKeys` first.
 *
 * Returns the (unchanged) absolute path.
 */
export const rewriteTask = async ($: Shell, task: FileRef, input: TaskInput, log?: Log): Promise<string> => {
  // Same last-write-boundary check `moveTask` makes: the target is built from
  // `task.id`, so an unsafe id (`../…`) would write outside the backlog.
  if (!isSafeTaskId(task.id)) {
    throw new Error(`cannot rewrite task: unsafe id ${JSON.stringify(task.id)}`)
  }
  statusOf(task) // throws when the file is not inside a status folder
  const dest = path.join(path.dirname(task.path), `${task.id}.md`)
  if (path.resolve(dest) !== path.resolve(task.path)) {
    throw new Error(`cannot rewrite ${task.id}: ${task.path} is not ${dest} — rewriteTask never renames or moves a task`)
  }
  const exists = await $`test -f ${dest}`.quiet().nothrow()
  if (exists.exitCode !== 0) {
    throw new Error(`cannot rewrite task ${task.id}: ${dest} does not exist — rewriteTask never creates a task (use writeTask)`)
  }
  const content = serializeTask(input) // validates before anything is written
  const out = await writeFileAtomic($, dest, content)
  if (out.exitCode !== 0) {
    throw new Error(`could not rewrite task ${task.id}: ${out.stderr.toString().trim()}`)
  }
  // Confirm it landed on the real FS, exactly as `moveTask` does — never report a
  // write that a stale path turned into a no-op.
  const check = await $`test -f ${dest}`.quiet().nothrow()
  if (check.exitCode !== 0) {
    throw new Error(`rewrite of ${task.id} did not land at ${dest}`)
  }
  log?.("info", `rewrote ${dest}`)
  return dest
}

/**
 * Rescue a stray task file (found by `auditBacklog` outside every status
 * folder — e.g. `docs/tasks/run/x.md`) back into `draft/`, the human-review
 * inbox. Deliberately bypasses `canTransition`: `statusOf` throws on unknown
 * folders, and a rescue is a repair, not a lifecycle move — `moveTask` stays
 * strict. Refuses to clobber an existing draft; returns the new path.
 */
export const rescueStray = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  relPath: string,
): Promise<{ id: string; path: string }> => {
  const id = path.basename(relPath).replace(/\.md$/i, "")
  const src = path.join(directory, relPath)
  const dest = path.join(directory, tasksDir, "draft", `${id}.md`)
  const exists = await $`test -e ${dest}`.quiet().nothrow()
  if (exists.exitCode === 0) {
    throw new Error(`cannot rescue ${relPath}: draft/${id}.md already exists — resolve the collision manually`)
  }
  await $`mkdir -p ${path.join(directory, tasksDir, "draft")}`.quiet().nothrow()
  // `-n` + the source re-check, for the reason spelled out in `moveTask`: the
  // existence check above is a TOCTOU pair with this move, and a plain `mv` lets
  // the loser of the race destroy the winner's file and audit trail.
  const out = await $`mv -n ${src} ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not rescue ${relPath} → draft/: ${out.stderr.toString().trim()}`)
  }
  const stillThere = await $`test -e ${src}`.quiet().nothrow()
  if (stillThere.exitCode === 0) {
    throw new Error(`cannot rescue ${relPath}: draft/${id}.md was created concurrently — resolve the collision manually`)
  }
  return { id, path: dest }
}

/** Warn about redaction hits without ever echoing the secret (names only). */
const warnRedaction = (hits: readonly { pattern: string; count: number }[], where: string, log?: Log): void => {
  if (!hits.length || !log) return
  const summary = hits.map((h) => `${h.pattern} ×${h.count}`).join(", ")
  log("warn", `redacted secret-shaped strings from ${where}: ${summary}`)
}

/**
 * Append a blockquote note to a task file **in place**. Secrets redacted.
 * Best-effort, and a no-op (with a warning) when the file is no longer there.
 *
 * The existence check is the whole point: `>>` CREATES its target, so an append
 * to a stale path — and callers legitimately hold one, since a task can move out
 * from under a live run — resurrected the task as a frontmatterless ghost. That
 * ghost is invisible where it would help and visible where it hurts:
 * `parseTask` throws on it so `listByStatus` skips it with a warn and it counts
 * for nothing, while `test -e` still sees it, so `moveTask`'s duplicate guard
 * then refuses the REAL task's move back into that folder — permanently, since
 * nothing sweeps a file no lister can see.
 *
 * Appending is never worth creating a file for: a note is a record OF a task
 * file, so no file means nothing to record. Warn instead — a lost note is lost
 * claim evidence (see `warnLostAppend`), and silence here reads as "noted".
 */
export const appendNote = async ($: Shell, task: FileRef, note: string, log?: Log): Promise<void> => {
  const { text, hits } = redact(note)
  warnRedaction(hits, `note on ${task.id}`, log)
  const exists = await $`test -f ${task.path}`.quiet().nothrow()
  if (exists.exitCode !== 0) {
    await log?.("warn", `note on ${task.id} never landed: ${task.path} no longer exists — the task moved or was removed`)
    return
  }
  // Chunked (fsatomic): the payload as one printf argument dies with E2BIG past
  // MAX_ARG_STRLEN on the spawn("bash",["-c"]) hosts — a silently lost note.
  const out = await appendFileChunked($, task.path, `\n> ${text}\n`)
  await warnLostAppend(out.exitCode, `note on ${task.id}`, log)
}

/** Appends stay best-effort, but a lost one must be LOUD: the CLAIMED/BUILD
 *  notes are the durable evidence the claim protocol depends on — silently
 *  losing one re-claims already-done work. */
const warnLostAppend = async (exitCode: number, what: string, log?: Log): Promise<void> => {
  if (exitCode !== 0) await log?.("warn", `append failed (exit ${exitCode}): ${what} never landed on disk`)
}

/**
 * Render an audit event note: the event text with a timestamp-and-actor
 * suffix. The suffix comes last so marker greps (`> BUILD started`, …) keep
 * matching. Pure.
 */
export const auditNote = (text: string, at: Date, actor?: string | null): string =>
  `${text} [${at.toISOString()}${actor ? ` by ${actor}` : ""}]`

/**
 * Append a stage's captured output to the loop's run log,
 * `<tasksDir>/runs/<id>.md` — the durable record of what each stage actually
 * said (verdict evidence, review findings), which the in-memory artifacts
 * are not. Best-effort.
 */
export const appendRunLog = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  id: string,
  header: string,
  text: string,
  log?: Log,
): Promise<void> => {
  const dir = path.join(directory, tasksDir, "runs")
  await $`mkdir -p ${dir}`.quiet().nothrow()
  const file = path.join(dir, `${id}.md`)
  const clean = redact(text)
  warnRedaction(clean.hits, `run log ${id}.md`, log)
  // Chunked (fsatomic): a stage transcript routinely exceeds MAX_ARG_STRLEN as
  // one printf argument — E2BIG, and the durable record's section vanished.
  const out = await appendFileChunked($, file, `\n## ${header}\n\n${clean.text}\n`)
  await warnLostAppend(out.exitCode, `run log ${id}.md`, log)
}

/** Append a plan under `PLAN_HEADING` to a task file in place. Secrets redacted. Best-effort. */
export const appendPlan = async ($: Shell, task: FileRef, plan: string, log?: Log): Promise<void> => {
  const { text, hits } = redact(plan)
  warnRedaction(hits, `plan on ${task.id}`, log)
  // Chunked (fsatomic): a large plan as one printf argument dies with E2BIG.
  const out = await appendFileChunked($, task.path, `\n${PLAN_HEADING}\n\n${text}\n`)
  await warnLostAppend(out.exitCode, `plan on ${task.id}`, log)
}

/** Existing task ids (filenames without `.md`) in a status folder; `[]` if absent. */
const listIds = async (client: Client, directory: string, rel: string): Promise<string[]> => {
  try {
    const res = await client.file.list({ query: { path: rel, directory } })
    return (res.data ?? [])
      .filter((n) => n.type === "file" && isMarkdown(n.name))
      .map((n) => n.name.replace(/\.md$/i, ""))
  } catch {
    return []
  }
}

/** Where a newly written task lands. Defaults to `draft/`, the human-review inbox. */
export interface WriteLocation {
  readonly directory: string
  readonly tasksDir?: string
  readonly status?: TaskStatus
}

/**
 * Create a task file programmatically from *inside the plugin runtime* (a
 * future in-plugin sync adapter — see docs/design/explore-task-fetch-and-pr-gating.md).
 * Needs an opencode `client` and Bun `$`, so it can't run as a plain terminal
 * command. For creating a task today, use `/agentic-workflow:engineering new <idea>` — the
 * `workflow-plan-author` subagent, which runs inside OpenCode; see the
 * `task-backlog-management` skill. Serializes + validates via `buildTaskFile`,
 * picks a non-colliding filename against what's already in the folder, and
 * writes it. Returns the new task's id and absolute path.
 */
export const writeTask = async (
  $: Shell,
  client: Client,
  loc: WriteLocation,
  input: TaskInput,
): Promise<{ id: string; path: string }> => {
  const tasksDir = loc.tasksDir ?? "docs/tasks"
  const status = loc.status ?? "draft"
  const rel = `${tasksDir}/${status}`
  // Gather ids across EVERY status folder, not just the destination — the minted short
  // hash must be unique board-wide so its 4-char handle unambiguously targets one task,
  // whichever folder the task has since advanced to.
  const taken = (await Promise.all(STATUSES.map((s) => listIds(client, loc.directory, `${tasksDir}/${s}`)))).flat()
  const { id, filename, content } = buildTaskFile(input, taken)

  const destDir = path.join(loc.directory, rel)
  const dest = path.join(destDir, filename)
  await $`mkdir -p ${destDir}`.quiet().nothrow()
  // Refuse to clobber an existing file. `taken` comes from the client index,
  // which can lag the real FS (see findByIdIn's note) — when it does,
  // `buildTaskFile` re-mints an id that is already on disk and
  // `writeFileAtomic`'s `mv` would silently destroy that task's file and audit
  // trail. Mirrors the guards in `moveTask` and `rescueStray`.
  const exists = await $`test -e ${dest}`.quiet().nothrow()
  if (exists.exitCode === 0) {
    throw new Error(`cannot write task ${filename}: ${rel}/${filename} already exists — resolve the duplicate manually`)
  }
  // `noClobber`, because the check above is a TOCTOU pair with the write: two
  // processes minting concurrently see the same lagging `taken` snapshot, can mint
  // the same id, and both find `dest` absent. The plain atomic write's rename
  // would then destroy the first task outright. This makes the kernel arbitrate.
  const out = await writeFileAtomic($, dest, content, { noClobber: true })
  if (out.exitCode !== 0) {
    throw new Error(`could not write task ${filename}: ${out.stderr.toString().trim()}`)
  }
  return { id, path: dest }
}
