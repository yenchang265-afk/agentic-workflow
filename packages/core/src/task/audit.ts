import type { Client } from "../host.js"
// Import STATUSES from the dependency-free leaf module, not store.js: auditBacklog
// is bundled into the Claude reconcile hook (esbuild), and pulling store.js would
// drag its yaml/zod machinery into that bundle.
import { STATUSES } from "./statuses.js"

/**
 * Backlog reconciliation sweep: detect the damage a confused agent can do
 * despite the guard — stray folders (`docs/tasks/run/`…), task files outside
 * any status folder, and one id present in several status folders at once.
 * Report-only: repair lives in `rescueStray` (store.ts) behind the explicit
 * `workflow_doctor` / `/agentic-workflow:engineering doctor` verbs.
 */

/** Non-status dirs that legitimately live at the backlog root. */
const KNOWN_NON_STATUS_DIRS: readonly string[] = ["runs"]

export interface BacklogAnomalies {
  /** Backlog-root subdirs that are neither a status folder nor `runs/`. */
  readonly unknownDirs: readonly string[]
  /** Repo-relative paths of `.md` files at the backlog root or inside unknown dirs. */
  readonly strayFiles: readonly string[]
  /** Task ids present in more than one status folder, with where they were seen.
   *  Statuses are strings, not `TaskStatus`: a custom kind's folders count too. */
  readonly duplicates: readonly { readonly id: string; readonly statuses: readonly string[] }[]
  /** Repo-relative paths of EMPTY `.md` files inside status folders. An empty
   *  task file is a fully silent ghost: `listByStatus` has nothing to parse, so
   *  it is invisible to every listing, claim walk, and gate verb while still
   *  squatting on its id — the backlog looks clean while a task has vanished. */
  readonly emptyFiles: readonly string[]
}

export const hasAnomalies = (a: BacklogAnomalies): boolean =>
  a.unknownDirs.length > 0 || a.strayFiles.length > 0 || a.duplicates.length > 0 || a.emptyFiles.length > 0

/**
 * Display-sanitize an on-disk name for a one-line report. Every value here is a
 * FILE NAME off the disk — a cloned repo can ship a directory whose name embeds
 * newlines (legal on Linux) — and these lines are injected into a model's
 * context at SessionStart by the reconcile hook, so a raw interpolation is an
 * attacker-authored line of context. Control characters render as `�` (the
 * damage stays visible rather than silently vanishing) and long names clamp. Pure.
 */
const printable = (name: string): string => {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "�")
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean
}

/** One human-readable warning line per finding, names display-sanitized (see `printable`). Pure. */
export const formatAnomalies = (a: BacklogAnomalies, tasksDir: string): string[] => [
  ...a.unknownDirs.map((d) => `unknown folder ${printable(tasksDir)}/${printable(d)}/ — not a status folder; a confused agent likely created it`),
  ...a.strayFiles.map((f) => `stray task file ${printable(f)} — outside every status folder, invisible to the loop`),
  ...a.duplicates.map(
    (d) => `duplicate task "${printable(d.id)}" in ${d.statuses.map(printable).join(", ")} — resolve manually (keep one, abandon the rest)`,
  ),
  ...a.emptyFiles.map(
    (fp) => `empty task file ${printable(fp)} — invisible to every listing and claim walk while squatting on its id; restore its content (e.g. from git) or remove the file`,
  ),
]

const isMarkdown = (name: string): boolean => name.toLowerCase().endsWith(".md")

const listDir = async (client: Client, directory: string, rel: string) => {
  try {
    const res = await client.file.list({ query: { path: rel, directory } })
    return res.data ?? []
  } catch {
    return []
  }
}

/**
 * Sweep the backlog for structural anomalies. Read-only. `statuses` is the set
 * of folders that legitimately hold tasks — core's engineering set by default;
 * a caller that knows the enabled kinds' manifests (the hub) passes the union
 * of their declared statuses so a custom kind's folders aren't flagged as
 * damage.
 */
export const auditBacklog = async (
  client: Client,
  directory: string,
  tasksDir: string,
  statuses: readonly string[] = STATUSES,
): Promise<BacklogAnomalies> => {
  const root = await listDir(client, directory, tasksDir)

  const unknownDirs = root
    .filter((n) => n.type === "directory" && !n.name.startsWith("."))
    .map((n) => n.name)
    .filter((name) => !statuses.includes(name) && !KNOWN_NON_STATUS_DIRS.includes(name))
    .sort()

  const strayFiles: string[] = root
    .filter((n) => n.type === "file" && isMarkdown(n.name))
    .map((n) => `${tasksDir}/${n.name}`)
  for (const dir of unknownDirs) {
    const nodes = await listDir(client, directory, `${tasksDir}/${dir}`)
    for (const n of nodes) {
      if (n.type === "file" && isMarkdown(n.name)) strayFiles.push(`${tasksDir}/${dir}/${n.name}`)
    }
  }

  const seen = new Map<string, string[]>()
  const emptyFiles: string[] = []
  for (const status of statuses) {
    const nodes = await listDir(client, directory, `${tasksDir}/${status}`)
    for (const n of nodes) {
      if (n.type !== "file" || !isMarkdown(n.name)) continue
      const id = n.name.replace(/\.md$/i, "")
      seen.set(id, [...(seen.get(id) ?? []), status])
      // Flag only VERIFIED emptiness: a read that fails or returns nothing is no
      // evidence (this also keeps the sweep read-tolerant on flaky mounts), and
      // these lines are injected into a session's context by the reconcile hook,
      // so a false accusation costs more than a missed one.
      try {
        const read = await client.file.read({ query: { path: n.path, directory } })
        const content = read.data?.content
        if (typeof content === "string" && content.trim() === "") emptyFiles.push(n.path)
      } catch {
        /* unreadable ≠ empty */
      }
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, statuses]) => statuses.length > 1)
    .map(([id, statuses]) => ({ id, statuses }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return { unknownDirs, strayFiles, duplicates, emptyFiles }
}
