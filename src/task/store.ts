import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { parseTask, type Task } from "./schema.ts"

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

export type TaskStatus = "draft" | "approved" | "in-progress" | "completed" | "rejected"

const approvedDir = (tasksDir: string): string => `${tasksDir}/approved`
const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md")

/** Pick the next task: lowest priority number, ties broken by id. Pure. */
export const selectNext = (tasks: readonly Task[]): Task | null => {
  const sorted = [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return sorted[0] ?? null
}

/**
 * List and parse every task in `approved/`. Invalid files are skipped (logged)
 * rather than failing the whole pick. Returns `[]` when the folder is absent.
 */
export const listApproved = async (
  client: Client,
  directory: string,
  tasksDir: string,
  log?: Log,
): Promise<Task[]> => {
  const dir = approvedDir(tasksDir)
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

/** Resolve a specific approved task by id, or null if missing/invalid. */
export const findById = async (
  client: Client,
  directory: string,
  tasksDir: string,
  id: string,
): Promise<Task | null> => {
  const filename = `${id}.md`
  const rel = `${approvedDir(tasksDir)}/${filename}`
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
