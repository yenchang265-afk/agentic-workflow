import fs from "node:fs"
import type { FileStamp, RunParseCacheEntry } from "@agentic-workflow/core/workflow/metrics-aggregate"

/**
 * The hub's parse cache for `runs/` (design 72): every `/api/metrics` request
 * used to re-read and re-parse every run log and sidecar, and the Metrics tab
 * refetches on every `versions.run`/`versions.tokens` SSE bump — on a WSL
 * DrvFs tree with hundreds of runs, that was the tab's whole latency. Core's
 * `readRunInputs` takes a stat + cache pair; this is the pair, one per repo
 * directory for the life of the process, keyed on size AND mtime (the lesson
 * `tokens/transcripts.ts` records: a same-length rewrite served stale).
 */
const caches = new Map<string, Map<string, RunParseCacheEntry>>()

export const runParseCacheFor = (directory: string): Map<string, RunParseCacheEntry> => {
  let c = caches.get(directory)
  if (!c) {
    c = new Map()
    caches.set(directory, c)
  }
  return c
}

export const statStamp = (absPath: string): FileStamp | null => {
  try {
    const st = fs.statSync(absPath)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}
