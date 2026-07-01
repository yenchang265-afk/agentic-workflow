import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { buildTaskFile, parseTask, type Task, type TaskInput } from "./schema.ts"

/**
 * Filesystem IO for the task backlog. **Impure**: reads via the opencode client
 * and moves files via the Bun shell (`$`), since the SDK has no file-write/move.
 * The folder a file lives in is its status; moves are how the driver advances a
 * task through its lifecycle.
 */

type Client = PluginInput["client"]
type Shell = PluginInput["$"]
type Log = (level: "info" | "warn" | "error", message: string) => unknown

/** Anything with an id + on-disk path can be moved or annotated. */
type FileRef = { readonly id: string; readonly path: string }

export type TaskStatus = "draft" | "in-progress" | "completed" | "abandoned"

const inProgressDir = (tasksDir: string): string => `${tasksDir}/in-progress`
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

/** The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure. */
export const extractPlan = (task: Task): string | undefined => {
  const idx = task.body.indexOf(PLAN_HEADING)
  if (idx === -1) return undefined
  return task.body.slice(idx + PLAN_HEADING.length).trim()
}

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

/**
 * List and parse every task in `in-progress/`. Invalid files are skipped
 * (logged) rather than failing the whole pick. Returns `[]` when the folder
 * is absent.
 */
export const listInProgress = async (
  client: Client,
  directory: string,
  tasksDir: string,
  log?: Log,
): Promise<Task[]> => {
  const dir = inProgressDir(tasksDir)
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

/** Resolve a specific in-progress task by id, or null if missing/invalid. */
export const findById = async (
  client: Client,
  directory: string,
  tasksDir: string,
  id: string,
): Promise<Task | null> => {
  const filename = `${id}.md`
  const rel = `${inProgressDir(tasksDir)}/${filename}`
  const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    return parseTask(filename, content, path.join(directory, rel))
  } catch {
    return null
  }
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
  return dest
}

/** Append a blockquote note to a task file in place. Best-effort. */
export const appendNote = async ($: Shell, task: FileRef, note: string): Promise<void> => {
  await $`printf '\n> %s\n' ${note} >> ${task.path}`.quiet().nothrow()
}

/** Append a plan under `PLAN_HEADING` to a task file in place. Best-effort. */
export const appendPlan = async ($: Shell, task: FileRef, plan: string): Promise<void> => {
  await $`printf '\n%s\n\n%s\n' ${PLAN_HEADING} ${plan} >> ${task.path}`.quiet().nothrow()
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
 * Create a task file programmatically (the "automatic" path — scripts, sync
 * adapters). Serializes + validates via `buildTaskFile`, picks a non-colliding
 * filename against what's already in the folder, and writes it. Returns the new
 * absolute path.
 */
export const writeTask = async (
  $: Shell,
  client: Client,
  loc: WriteLocation,
  input: TaskInput,
): Promise<string> => {
  const tasksDir = loc.tasksDir ?? "docs/tasks"
  const status = loc.status ?? "draft"
  const rel = `${tasksDir}/${status}`
  const taken = await listIds(client, loc.directory, rel)
  const { filename, content } = buildTaskFile(input, taken)

  const destDir = path.join(loc.directory, rel)
  const dest = path.join(destDir, filename)
  await $`mkdir -p ${destDir}`.quiet().nothrow()
  const out = await $`printf '%s' ${content} > ${dest}`.quiet().nothrow()
  if (out.exitCode !== 0) {
    throw new Error(`could not write task ${filename}: ${out.stderr.toString().trim()}`)
  }
  return dest
}
