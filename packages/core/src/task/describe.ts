import type { Task } from "./schema.js"
import type { TaskStatus } from "./statuses.js"
import {
  extractAbandonOrigin,
  extractPlan,
  extractReplanReason,
  extractRunBase,
  extractRunBranch,
  extractRunDiffstat,
  extractStopContext,
  isClaimable,
  priorRunFor,
  type PriorRun,
  wasInterrupted,
} from "./store.js"

/**
 * One task, projected for a human to read (design 55, `show <id>`). Pure.
 *
 * `status` is a backlog-wide roll-up: it names the folders' counts and the
 * tasks waiting on a verb, and nothing on either host printed ONE task — its
 * frontmatter, whether it carries a plan, the reason the last plan was
 * rejected, what a stopped run left behind, its audit trail. The hub's task
 * drawer had all of it; the CLI hosts had `cat`. This module is the shared
 * projection both hosts render, so what `show` says is decided once.
 *
 * Every field is derived by the parsers the gates already trust — the stamped
 * audit-line rules, never a scan of the prose — so `show` cannot disagree with
 * what the next gate verb will do.
 */

/** One `> <event> [<ISO> by <actor>]` audit blockquote from a task body. */
export interface AuditNote {
  readonly event: string
  readonly at: string
  readonly by: string
}

// Deliberately permissive, unlike `AUDIT_NOTE_LINE_RE` (plan-section.ts),
// which requires the stamp because it marks where the plan text ends — there a
// stray blockquote would truncate the plan, here it only adds a timeline row.
// Keep the two separate.
const STAMPED = /^>\s+(.*?)\s+\[([^\]]+?)\s+by\s+([^\]]+)\]\s*$/
const PLAIN = /^>\s+(\S.*?)\s*$/

/**
 * The audit blockquote trail of a task body, in order. Stamped lines carry
 * `at`/`by`; a plain `> …` blockquote is kept with both empty so the timeline
 * stays complete. Pure. (Moved here from the hub, which re-exports it.)
 */
export const extractAuditNotes = (body: string): AuditNote[] => {
  const notes: AuditNote[] = []
  for (const line of body.split("\n")) {
    const stamped = STAMPED.exec(line)
    if (stamped) {
      notes.push({ event: stamped[1] as string, at: stamped[2] as string, by: stamped[3] as string })
      continue
    }
    const plain = PLAIN.exec(line)
    if (plain) notes.push({ event: plain[1] as string, at: "", by: "" })
  }
  return notes
}

/** What `show <id>` reports. Optional keys are OMITTED when the task carries nothing for them. */
export interface TaskDescription {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly path: string
  readonly type?: string
  readonly priority: number
  readonly labels: readonly string[]
  readonly epic?: string
  readonly blockedBy: readonly string[]
  readonly acceptance: readonly string[]
  readonly hasPlan: boolean
  /** Build-ready in `in-progress/` (plan approved, no BUILD yet) — what a claim walk would take. */
  readonly claimable: boolean
  /** A claim marker is held on it (a loop may be driving it). */
  readonly claimed: boolean
  /** A run stopped early; `recover <id>` resumes it. */
  readonly interrupted: boolean
  /** The plan gate's pending rejection reason, when the next PLAN pass owes an answer to one. */
  readonly replanReason?: string
  /** The attempts digest of the last cap-stopped run. */
  readonly stopContext?: string
  /** What the last stopped run left on its branch (design 51). */
  readonly priorRun?: PriorRun
  /** The branch/base/diffstat the last COMPLETED run recorded. */
  readonly runBranch?: string
  readonly runBase?: string
  readonly runDiffstat?: string
  /** For an abandoned task: the folder it was abandoned from — where `restore` would... not send it (it always lands in draft/). */
  readonly abandonedFrom?: TaskStatus
  readonly notes: readonly AuditNote[]
}

export interface DescribeOpts {
  /** A claim marker is held for the task in its folder. */
  readonly claimed?: boolean
  /** A state snapshot names it (the exact-stage oracle `recover` reads). */
  readonly snapshot?: boolean
}

/** Project one task. Pure. */
export const describeTask = (task: Task, status: TaskStatus, opts: DescribeOpts = {}): TaskDescription => {
  const claimed = opts.claimed === true
  const claimable = status === "in-progress" && isClaimable(task) && !claimed
  // The same rule `summarizeBacklog` applies: a snapshot beside a still-claimable
  // body is a stale leftover, not an interruption.
  const interrupted = status === "in-progress" && (wasInterrupted(task) || (opts.snapshot === true && !isClaimable(task)))
  const withOpt = <K extends keyof TaskDescription>(key: K, value: TaskDescription[K] | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Pick<TaskDescription, K>)
  return {
    id: task.id,
    title: task.title,
    status,
    path: task.path,
    ...withOpt("type", task.type),
    priority: task.priority,
    labels: task.labels,
    ...withOpt("epic", task.epic),
    blockedBy: task.blockedBy,
    acceptance: task.acceptance,
    hasPlan: !!extractPlan(task),
    claimable,
    claimed,
    interrupted,
    ...withOpt("replanReason", extractReplanReason(task)),
    ...withOpt("stopContext", extractStopContext(task)),
    ...withOpt("priorRun", priorRunFor(task)),
    ...withOpt("runBranch", extractRunBranch(task)),
    ...withOpt("runBase", extractRunBase(task)),
    ...withOpt("runDiffstat", extractRunDiffstat(task)),
    ...withOpt("abandonedFrom", status === "abandoned" ? extractAbandonOrigin(task) : undefined),
    notes: extractAuditNotes(task.body),
  }
}

/** Audit notes a rendered description shows, newest last. Older ones are counted, not printed. */
export const SHOWN_NOTES = 8

/**
 * The lines both hosts print for `show`. Pure. One renderer, so the two hosts
 * — and the model relaying an OpenCode result — read the same report.
 */
export const formatTaskDescription = (d: TaskDescription, shownNotes = SHOWN_NOTES): string[] => {
  const flags: string[] = []
  if (d.claimed) flags.push("claim held")
  if (d.interrupted) flags.push("interrupted — recover")
  if (d.claimable) flags.push("build-ready")
  if (d.hasPlan) flags.push("plan")
  const head = `${d.id} — ${d.status}/ · priority ${String(d.priority)}${d.type ? ` · ${d.type}` : ""}${flags.length ? ` · ${flags.join(", ")}` : ""}`
  const lines = [head, `  ${d.title}`]
  if (d.epic) lines.push(`  epic: ${d.epic}`)
  if (d.blockedBy.length) lines.push(`  blocked by: ${d.blockedBy.join(", ")}`)
  if (d.labels.length) lines.push(`  labels: ${d.labels.join(", ")}`)
  if (d.acceptance.length) {
    lines.push(`  acceptance (${String(d.acceptance.length)}):`)
    for (const a of d.acceptance) lines.push(`    - ${a}`)
  }
  if (d.abandonedFrom) lines.push(`  abandoned from: ${d.abandonedFrom}/ (restore <id> returns it to draft/)`)
  if (d.replanReason) lines.push(`  pending replan reason: ${d.replanReason}`)
  if (d.stopContext) lines.push(`  last run stopped — ${d.stopContext}`)
  if (d.priorRun?.branch) lines.push(`  prior work on ${d.priorRun.branch}${d.priorRun.base ? ` (base ${d.priorRun.base})` : ""}${d.priorRun.diffstat ? `: ${d.priorRun.diffstat}` : ""}`)
  if (d.runBranch) lines.push(`  run branch: ${d.runBranch}${d.runBase ? ` (base ${d.runBase})` : ""}${d.runDiffstat ? ` — ${d.runDiffstat}` : ""}`)
  if (d.notes.length) {
    const shown = d.notes.slice(-shownNotes)
    const hidden = d.notes.length - shown.length
    lines.push(`  audit trail${hidden > 0 ? ` (${String(hidden)} earlier not shown)` : ""}:`)
    for (const n of shown) lines.push(`    ${n.at ? `${n.at} ` : ""}${n.event}${n.by ? ` [${n.by}]` : ""}`)
  }
  lines.push(`  file: ${d.path}`)
  return lines
}
