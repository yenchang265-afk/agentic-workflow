import fs from "node:fs"
import path from "node:path"

/**
 * Filesystem watching for live updates. Two always-on triggers feed one
 * debounced rescan: `fs.watch` (recursive) for instant events, and a polling
 * reconciler — NOT a fallback: this repo commonly lives on WSL DrvFs (/mnt/c)
 * where inotify is unreliable, so the poll is what guarantees delivery. The
 * scan is cheap (readdir + stat, no file reads) and `diffSnapshots` is pure,
 * so double-delivery just produces an empty diff.
 */

export interface WatchSnapshot {
  /** status → task filename → mtimeMs */
  readonly tasks: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** runs/ filename → size+mtime key */
  readonly runs: Readonly<Record<string, string>>
  /** .stage.json key, or null when absent */
  readonly stageMarker: string | null
  /** watch-lease owner.json key, or null */
  readonly lease: string | null
  /**
   * `.agentic-workflow.json` key, or null when absent. It lives outside `tasksDir`,
   * so the recursive `fs.watch` never sees it — the poll is what delivers this
   * one, which is exactly the guarantee the poll exists for.
   */
  readonly config: string | null
}

export type { HubEventBase } from "../shared/api.js"
import type { HubEventBase } from "../shared/api.js"

const statKey = (file: string): string | null => {
  try {
    const s = fs.statSync(file)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return null
  }
}

/** Cheap scan of the observable state under `<directory>/<tasksDir>`. */
export const scanSnapshot = (directory: string, tasksDir: string, statuses: readonly string[]): WatchSnapshot => {
  const root = path.join(directory, tasksDir)
  const tasks: Record<string, Record<string, number>> = {}
  for (const status of statuses) {
    const dir = path.join(root, status)
    const entries: Record<string, number> = {}
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".md")) continue
        try {
          entries[name] = fs.statSync(path.join(dir, name)).mtimeMs
        } catch {
          // raced a move — next scan catches it
        }
      }
    } catch {
      // folder absent
    }
    tasks[status] = entries
  }
  const runs: Record<string, string> = {}
  const runsDir = path.join(root, "runs")
  try {
    for (const name of fs.readdirSync(runsDir)) {
      if (!name.endsWith(".md") && !name.endsWith(".state.json") && !name.endsWith(".metrics.json")) continue
      const key = statKey(path.join(runsDir, name))
      if (key !== null) runs[name] = key
    }
  } catch {
    // no runs yet
  }
  return {
    tasks,
    runs,
    stageMarker: statKey(path.join(runsDir, ".stage.json")),
    lease: statKey(path.join(runsDir, ".watch-lease", "owner.json")),
    config: statKey(path.join(directory, ".agentic-workflow.json")),
  }
}

/**
 * Derive events from two snapshots; `gateStatuses` are the folders (from the
 * enabled kinds' manifests) whose new arrivals are "the loop wants you"
 * moments. Pure; equal snapshots → [].
 */
export const diffSnapshots = (
  prev: WatchSnapshot,
  next: WatchSnapshot,
  gateStatuses: readonly string[],
): HubEventBase[] => {
  const events: HubEventBase[] = []

  let backlogChanged = false
  const statuses = new Set([...Object.keys(prev.tasks), ...Object.keys(next.tasks)])
  for (const status of statuses) {
    const before = prev.tasks[status] ?? {}
    const after = next.tasks[status] ?? {}
    const names = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const name of names) {
      if (before[name] !== after[name]) backlogChanged = true
      // a task newly appearing in a gate folder is the "loop wants you" moment
      if (gateStatuses.includes(status) && before[name] === undefined && after[name] !== undefined) {
        events.push({ type: "gate", taskId: name.replace(/\.md$/, ""), toStatus: status })
      }
    }
  }
  if (backlogChanged) events.push({ type: "backlog" })

  const runNames = new Set([...Object.keys(prev.runs), ...Object.keys(next.runs)])
  let activeChanged = prev.stageMarker !== next.stageMarker || prev.lease !== next.lease
  for (const name of runNames) {
    if (prev.runs[name] === next.runs[name]) continue
    if (name.endsWith(".state.json")) activeChanged = true
    // A live per-stage flush rewrites the metrics sidecar; emit `tokens` (NOT
    // `run`, which would collapse the open run panel) so only TokenPanel refetches.
    else if (name.endsWith(".metrics.json")) events.push({ type: "tokens", id: name.replace(/\.metrics\.json$/, "") })
    else events.push({ type: "run", id: name.replace(/\.md$/, "") })
  }
  if (activeChanged) events.push({ type: "active" })

  // Config changed on disk — from the hub's own save, or a hand-edit in $EDITOR.
  // The server reloads before fanning this out (see main.ts), because config is
  // otherwise read once at startup.
  if (prev.config !== next.config) events.push({ type: "config" })

  return events
}

export interface WatcherOptions {
  readonly directory: string
  readonly tasksDir: string
  readonly statuses: readonly string[]
  /** Folders whose new arrivals emit `gate` events (from the kinds' manifests). */
  readonly gateStatuses: readonly string[]
  /** Poll interval — the delivery guarantee on DrvFs. */
  readonly pollMs?: number
  /** fs.watch debounce. */
  readonly debounceMs?: number
  /** Called when fs.watch could not start (recursive watch unsupported, dir
   *  missing) — delivery silently degrades to the poll otherwise, and a broken
   *  watcher is indistinguishable from a working one. */
  readonly onDegraded?: (reason: string) => void
}

/** Start watching; `onEvents` fires with each non-empty diff. Returns a stop function. */
export const startWatcher = (opts: WatcherOptions, onEvents: (events: HubEventBase[]) => void): (() => void) => {
  let snapshot = scanSnapshot(opts.directory, opts.tasksDir, opts.statuses)
  let debounce: NodeJS.Timeout | null = null

  const rescan = (): void => {
    const next = scanSnapshot(opts.directory, opts.tasksDir, opts.statuses)
    const events = diffSnapshots(snapshot, next, opts.gateStatuses)
    snapshot = next
    if (events.length > 0) onEvents(events)
  }

  const poke = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(rescan, opts.debounceMs ?? 300)
  }

  let watcher: fs.FSWatcher | null = null
  try {
    watcher = fs.watch(path.join(opts.directory, opts.tasksDir), { recursive: true }, poke)
  } catch (err) {
    // watch unavailable (or dir missing) — the poll still delivers, but say so.
    opts.onDegraded?.((err as Error).message)
  }
  const poll = setInterval(rescan, opts.pollMs ?? 4000)

  return () => {
    if (debounce) clearTimeout(debounce)
    clearInterval(poll)
    watcher?.close()
  }
}
