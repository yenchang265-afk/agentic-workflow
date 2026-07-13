import path from "node:path"
import type { Client, Log, Shell } from "../host.js"
import { redact } from "./redact.js"
import { buildTaskFile, isPaired, parseTask, SHORT_ID_RE, shortIdOf, type Task, type TaskInput } from "./schema.js"

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

/** Marks a task as planned, awaiting approval — appended to its body by `appendPlan`. */
export const PLAN_HEADING = "## Implementation Plan"

/** Whether a task already has a plan persisted (appended at a prior approval gate). Pure. */
export const hasPlan = (task: Task): boolean => task.body.includes(PLAN_HEADING)

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

/** The body of the task's current lifecycle: everything after the last
 *  plan-approval note; the whole body when none exists (legacy tasks). Pure. */
const lifecycleWindow = (body: string): string => {
  const idx = body.lastIndexOf(PLAN_APPROVED_MARKER)
  return idx === -1 ? body : body.slice(idx)
}

/**
 * Eligible for `/agentic-loop:engineering watch` to claim: planned, with no
 * "> BUILD started" or CLAIMED note in the current lifecycle window — not just
 * "last pair unmatched" (that's `wasInterrupted`, below). A marker in the
 * window means another live LoopState is driving it right now, or it crashed
 * and needs manual recovery — a watch session must never silently reclaim
 * either case. Pure.
 */
export const isClaimable = (task: Task): boolean => {
  const window = lifecycleWindow(task.body)
  return hasPlan(task) && !window.includes("> BUILD started") && !window.includes(CLAIMED_MARKER)
}

/** The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure. */
export const extractPlan = (task: Task): string | undefined => {
  const idx = task.body.indexOf(PLAN_HEADING)
  if (idx === -1) return undefined
  return task.body.slice(idx + PLAN_HEADING.length).trim()
}

/**
 * Planned and started at least once in the current lifecycle window — no longer
 * claimable by `/agentic-loop:engineering watch`, but a human can force-resume it
 * with `/agentic-loop:engineering recover <id>` once no live loop is driving it
 * (crashed runs, restarted plugins). Pure.
 */
export const isRecoverable = (task: Task): boolean => {
  const window = lifecycleWindow(task.body)
  return hasPlan(task) && (window.includes("> BUILD started") || window.includes(CLAIMED_MARKER))
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
  const lastStart = window.lastIndexOf("> BUILD started")
  if (lastStart === -1) return false
  const lastFinish = window.lastIndexOf("> BUILD finished")
  return lastFinish < lastStart
}

/** A per-status roll-up of the backlog for `/agentic-loop:engineering status`. Pure. */
export interface BacklogSummary {
  readonly counts: Readonly<Record<TaskStatus, number>>
  /** queued tasks awaiting the loop's PLAN stage (a watcher will claim them once no build work remains). */
  readonly awaitingPlan: readonly string[]
  /** plan-review tasks whose plan is parked for human review (/agentic-loop:engineering approve). */
  readonly gated: readonly string[]
  /** in-progress tasks parked and never started (a watcher will claim them). */
  readonly claimable: readonly string[]
  /** in-progress tasks whose body is claimable but whose claim marker is currently held. */
  readonly claimHeld: readonly string[]
  /** in-progress tasks whose last build looks interrupted (crashed — /agentic-loop:engineering recover). */
  readonly interrupted: readonly string[]
  /** in-review tasks awaiting a human diff review (/agentic-loop:engineering approve). */
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
 * Feeds the `loop_status` pairing view when project management is configured. Pure.
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
    if (!content) continue
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

/** List and parse every task in `in-progress/` — the pool `/agentic-loop:engineering watch` claims from. */
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
 * (`plan`, `recover`, loop_start) accepts the same short handles the UIs
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

/**
 * Atomically claim a task for execution. A plain (non-recursive) `mkdir` of
 * the marker either succeeds — claim won — or fails because another watcher
 * on this filesystem already holds it. Closes the window between listing
 * claimable tasks and appending the `> BUILD started` note.
 */
export const claimTask = async ($: Shell, task: FileRef): Promise<boolean> => {
  await $`mkdir -p ${claimsDir(task.path)}`.quiet().nothrow()
  const out = await $`mkdir ${path.join(claimsDir(task.path), task.id)}`.quiet().nothrow()
  return out.exitCode === 0
}

/** Release a task's claim marker, if present. Best-effort. */
export const releaseClaim = async ($: Shell, task: FileRef): Promise<void> => {
  await $`rmdir ${path.join(claimsDir(task.path), task.id)}`.quiet().nothrow()
}

/**
 * A claim marker older than this, on a task with no BUILD note and no live
 * loop, is treated as orphaned — its claimer died between `claimTask` and the
 * first "BUILD started" note. Must exceed the worst-case claim→BUILD-note
 * window, including a slow `worktreeSetup` (e.g. npm ci).
 */
export const STALE_CLAIM_MINUTES = 15

/**
 * Whether a `FileRef`'s claim marker exists and is older than `minutes`.
 * `find -mmin +N` prints the path only when strictly older (GNU and BSD).
 * Any failure — marker absent, or a `find` without `-mmin` semantics — reads
 * as "not stale", degrading safely to "marker stays held".
 */
export const claimOlderThan = async ($: Shell, task: FileRef, minutes: number): Promise<boolean> => {
  const marker = path.join(claimsDir(task.path), task.id)
  const out = await $`find ${marker} -maxdepth 0 -mmin +${String(minutes)}`.quiet().nothrow()
  return out.exitCode === 0 && out.stdout.toString().trim().length > 0
}

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
  return out.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * An orphaned claim: the task body never recorded a BUILD (still claimable),
 * no live loop is driving it, and the marker has aged past the crash window.
 * Only such markers may be released without racing a live claimer. Pure.
 */
export const isOrphanedClaim = (
  task: Task,
  opts: { readonly drivenByLiveLoop: boolean; readonly markerStale: boolean },
): boolean => isClaimable(task) && !opts.drivenByLiveLoop && opts.markerStale

/**
 * The `queued/` variant of `isOrphanedClaim`: a queued task is planless by
 * definition (no `isClaimable` gate applies) and its PLAN stage never writes
 * code, so a stale, undriven marker is always safe to release — a died PLAN
 * left at most a partial plan on the task file, which the next PLAN pass
 * overwrites. Pure.
 */
export const isOrphanedPlanClaim = (
  _task: Task,
  opts: { readonly drivenByLiveLoop: boolean; readonly markerStale: boolean },
): boolean => !opts.drivenByLiveLoop && opts.markerStale

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
  },
): Promise<ClaimAttempt> => {
  const heldIds: string[] = []
  const isOrphaned = opts.isOrphaned ?? isOrphanedClaim
  for (const task of candidates) {
    if (await claimTask($, task)) return { claimed: task, heldIds }
    const markerStale = await claimOlderThan($, task, opts.staleMinutes ?? STALE_CLAIM_MINUTES)
    if (isOrphaned(task, { drivenByLiveLoop: opts.isDriving(task.id), markerStale })) {
      opts.log?.("warn", `releasing orphaned claim marker for ${task.id} — its claimer died before the stage started`)
      await releaseClaim($, task)
      if (await claimTask($, task)) return { claimed: task, heldIds }
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
      ? isOrphaned(task, { drivenByLiveLoop: opts.isDriving(id), markerStale })
      : markerStale && !opts.isDriving(id)
    if (!orphaned) continue
    await releaseClaim($, ref)
    released.push(id)
  }
  return released
}

/** The forward lifecycle order (excludes `abandoned`, which is a cancellation escape, not a stage). */
const FORWARD_ORDER: readonly TaskStatus[] = ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"]

/**
 * Whether a task may move from `from` to `to`. Tasks advance exactly one
 * stage at a time — no skipping — with two escapes: any non-terminal stage
 * may be abandoned directly (cancellation isn't a forward skip), and a
 * replan sends `plan-review` or `in-progress` back to `queued` (the plan was
 * rejected or the loop capped out — the PLAN stage runs again). `completed`
 * and `abandoned` are terminal: nothing moves out of them. Pure.
 */
export const canTransition = (from: TaskStatus, to: TaskStatus): boolean => {
  if (from === "completed" || from === "abandoned") return false
  if (to === "abandoned") return true
  if (to === "queued" && (from === "plan-review" || from === "in-progress")) return true
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
  const fromStatus = statusOf(task)
  if (!canTransition(fromStatus, toStatus)) {
    throw new Error(`cannot move ${task.id} from ${fromStatus} to ${toStatus} — tasks must advance one stage at a time`)
  }
  const root = path.dirname(path.dirname(task.path)) // …/docs/tasks
  const destDir = path.join(root, toStatus)
  const dest = path.join(destDir, `${task.id}.md`)
  await $`mkdir -p ${destDir}`.quiet().nothrow()
  const out = await $`mv ${task.path} ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not move ${task.id} → ${toStatus}: ${out.stderr.toString().trim()}`)
  }
  // Confirm the file actually landed on the real FS — never let a caller report a
  // move that didn't happen (a stale `task.path` can make `mv` a silent no-op-ish).
  const check = await $`test -f ${dest}`.quiet().nothrow()
  if (check.exitCode !== 0) {
    throw new Error(`move of ${task.id} → ${toStatus} did not land at ${dest}`)
  }
  await releaseClaim($, task) // a claim belongs to the status folder it was taken in
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
  const out = await $`mv ${src} ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not rescue ${relPath} → draft/: ${out.stderr.toString().trim()}`)
  }
  return { id, path: dest }
}

/** Warn about redaction hits without ever echoing the secret (names only). */
const warnRedaction = (hits: readonly { pattern: string; count: number }[], where: string, log?: Log): void => {
  if (!hits.length || !log) return
  const summary = hits.map((h) => `${h.pattern} ×${h.count}`).join(", ")
  log("warn", `redacted secret-shaped strings from ${where}: ${summary}`)
}

/** Append a blockquote note to a task file in place. Secrets redacted. Best-effort. */
export const appendNote = async ($: Shell, task: FileRef, note: string, log?: Log): Promise<void> => {
  const { text, hits } = redact(note)
  warnRedaction(hits, `note on ${task.id}`, log)
  await $`printf '\n> %s\n' ${text} >> ${task.path}`.quiet().nothrow()
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
  await $`printf '\n## %s\n\n%s\n' ${header} ${clean.text} >> ${file}`.quiet().nothrow()
}

/** Append a plan under `PLAN_HEADING` to a task file in place. Secrets redacted. Best-effort. */
export const appendPlan = async ($: Shell, task: FileRef, plan: string, log?: Log): Promise<void> => {
  const { text, hits } = redact(plan)
  warnRedaction(hits, `plan on ${task.id}`, log)
  await $`printf '\n%s\n\n%s\n' ${PLAN_HEADING} ${text} >> ${task.path}`.quiet().nothrow()
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
 * command. For creating a task today, use `/agentic-loop:engineering new <idea>` — the
 * `loop-plan-author` subagent, which runs inside OpenCode; see the
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
  const out = await $`printf '%s' ${content} > ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not write task ${filename}: ${out.stderr.toString().trim()}`)
  }
  return { id, path: dest }
}
