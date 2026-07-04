import type { Shell, Client } from "../../shim.js"
import path from "node:path"
import { redact } from "./redact.js"
import { buildTaskFile, parseTask, type Task, type TaskInput } from "./schema.js"

/**
 * Filesystem IO for the task backlog. **Impure**: reads via the opencode client
 * and moves files via the Bun shell (`$`), since the SDK has no file-write/move.
 * The folder a file lives in is its status; moves are how the driver advances a
 * task through its lifecycle.
 */

type Log = (level: "info" | "warn" | "error", message: string) => unknown

/** Anything with an id + on-disk path can be moved or annotated. */
type FileRef = { readonly id: string; readonly path: string }

export type TaskStatus = "draft" | "in-planning" | "in-progress" | "in-review" | "completed" | "abandoned"

const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md")

/** Pick the next task: lowest priority number, ties broken by id. Pure. */
export const selectNext = (tasks: readonly Task[]): Task | null => {
  const sorted = [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return sorted[0] ?? null
}

/** Marks a task as planned, awaiting approval — appended to its body by `appendPlan`. */
export const PLAN_HEADING = "## Implementation Plan"

/** Whether a task already has a plan persisted (appended at a prior approval gate). Pure. */
export const hasPlan = (task: Task): boolean => task.body.includes(PLAN_HEADING)

/**
 * Eligible for `/agent-loop watch` to claim: planned, and never had ANY
 * "> BUILD started" note — not just "last pair unmatched" (that's
 * `wasInterrupted`, below). Any marker at all means another live LoopState
 * is driving it right now, or it crashed and needs manual recovery — a
 * watch session must never silently reclaim either case. Pure.
 */
export const isClaimable = (task: Task): boolean => hasPlan(task) && !task.body.includes("> BUILD started")

/** The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure. */
export const extractPlan = (task: Task): string | undefined => {
  const idx = task.body.indexOf(PLAN_HEADING)
  if (idx === -1) return undefined
  return task.body.slice(idx + PLAN_HEADING.length).trim()
}

/**
 * Planned and started at least once — no longer claimable by `/agent-loop watch`,
 * but a human can force-resume it with `/agent-loop recover <id>` once no live
 * loop is driving it (crashed runs, restarted plugins). Pure.
 */
export const isRecoverable = (task: Task): boolean => hasPlan(task) && task.body.includes("> BUILD started")

/**
 * Whether the task's last recorded BUILD run has no matching "finished" note —
 * i.e. the process likely died mid-build, possibly leaving a half-finished diff
 * in the working tree. Only BUILD is tracked: it's the sole stage that writes
 * code. Pure.
 */
export const wasInterrupted = (task: Task): boolean => {
  const lastStart = task.body.lastIndexOf("> BUILD started")
  if (lastStart === -1) return false
  const lastFinish = task.body.lastIndexOf("> BUILD finished")
  return lastFinish < lastStart
}

/** The status folders, in lifecycle order. */
export const STATUSES: readonly TaskStatus[] = [
  "draft",
  "in-planning",
  "in-progress",
  "in-review",
  "completed",
  "abandoned",
]

/** A per-status roll-up of the backlog for `/agent-loop status`. Pure. */
export interface BacklogSummary {
  readonly counts: Readonly<Record<TaskStatus, number>>
  /** in-planning tasks that already have a persisted plan (gated, awaiting /agent-loop go). */
  readonly gated: readonly string[]
  /** in-progress tasks parked and never started (a watcher will claim them). */
  readonly claimable: readonly string[]
  /** in-progress tasks whose last build looks interrupted (crashed — /agent-loop recover). */
  readonly interrupted: readonly string[]
  /** in-review tasks awaiting a human diff review (/agent-loop ship). */
  readonly awaitingReview: readonly string[]
}

/** Roll up tasks-by-status into counts and actionable flag lists. Pure. */
export const summarizeBacklog = (byStatus: Readonly<Record<TaskStatus, readonly Task[]>>): BacklogSummary => {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, byStatus[s]?.length ?? 0])) as Record<TaskStatus, number>
  const ids = (tasks: readonly Task[]): string[] => tasks.map((t) => t.id)
  const inPlanning = byStatus["in-planning"] ?? []
  const inProgress = byStatus["in-progress"] ?? []
  return {
    counts,
    gated: ids(inPlanning.filter(hasPlan)),
    claimable: ids(inProgress.filter(isClaimable)),
    interrupted: ids(inProgress.filter(wasInterrupted)),
    awaitingReview: ids(byStatus["in-review"] ?? []),
  }
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
  status: TaskStatus,
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

/** List and parse every task in `in-planning/`. See `listByStatus`. */
export const listInPlanning = (client: Client, directory: string, tasksDir: string, log?: Log): Promise<Task[]> =>
  listByStatus(client, directory, tasksDir, "in-planning", log)

/** List and parse every task in `in-progress/` — the pool `/agent-loop watch` claims from. */
export const listInProgress = (client: Client, directory: string, tasksDir: string, log?: Log): Promise<Task[]> =>
  listByStatus(client, directory, tasksDir, "in-progress", log)

/** Resolve a specific task by id within a status folder, or null if missing/invalid. */
export const findByIdIn = async (
  client: Client,
  directory: string,
  tasksDir: string,
  status: TaskStatus,
  id: string,
): Promise<Task | null> => {
  const filename = `${id}.md`
  const rel = `${tasksDir}/${status}/${filename}`
  const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    return parseTask(filename, content, path.join(directory, rel))
  } catch {
    return null
  }
}

/** Resolve a specific in-planning task by id, or null if missing/invalid. */
export const findById = (client: Client, directory: string, tasksDir: string, id: string): Promise<Task | null> =>
  findByIdIn(client, directory, tasksDir, "in-planning", id)

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

/** Move a task file into a new status folder. Returns its new absolute path. */
export const moveTask = async ($: Shell, task: FileRef, toStatus: TaskStatus): Promise<string> => {
  const root = path.dirname(path.dirname(task.path)) // …/docs/tasks
  const destDir = path.join(root, toStatus)
  const dest = path.join(destDir, `${task.id}.md`)
  await $`mkdir -p ${destDir}`.quiet().nothrow()
  const out = await $`mv ${task.path} ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not move ${task.id} → ${toStatus}: ${out.stderr.toString().trim()}`)
  }
  await releaseClaim($, task) // a claim belongs to the status folder it was taken in
  return dest
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
 * command. For creating (and optionally Azure DevOps-linking) a task today,
 * use `/task new <idea>` — the `task-author` subagent, which runs inside
 * OpenCode and can reach the Azure DevOps MCP server; see the
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
  const taken = await listIds(client, loc.directory, rel)
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
