import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StageTokens } from "@agentic-workflow/core/workflow/metrics"

/**
 * opencode.db reader — backfill for opencode runs that predate the driver's
 * token capture. Uses node:sqlite (readonly; WAL permits concurrent readers)
 * behind a feature-detected dynamic import: it needs Node ≥22.5, and on older
 * runtimes the endpoint degrades with a reason instead of failing. Only ever
 * queries `WHERE sessionID = ?` (from the metrics sidecar) — never scans; the
 * database can be gigabytes.
 */

export const defaultOpencodeDbPath = (): string => path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")

export interface SessionUsage {
  readonly tokens: StageTokens
  readonly cost: number
  readonly messages: number
}

export type DbResult = { available: true; usage: SessionUsage } | { available: false; reason: string }

interface SqliteModule {
  DatabaseSync: new (path: string, opts: { readOnly: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] }
    close(): void
  }
}

const loadSqlite = async (): Promise<SqliteModule | null> => {
  try {
    return (await import("node:sqlite")) as unknown as SqliteModule
  } catch {
    return null
  }
}

// Keys embed the db mtime, so every write to opencode.db mints a fresh key per
// session queried — unbounded, this grows for the life of the hub. FIFO-evict
// past a cap; stale-mtime entries are dead weight anyway.
const CACHE_CAP = 256
const cache = new Map<string, SessionUsage>()
const remember = (key: string, usage: SessionUsage): void => {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, usage)
}

export const readSessionUsage = async (dbPath: string, sessionID: string): Promise<DbResult> => {
  // One stat answers both "is it there" and "did it change". A failed stat on
  // an existing file means we cannot tell whether the DB changed, so BYPASS
  // the cache entirely — a fixed fallback key would serve stale usage under
  // `<session>:0` every time stat hiccups.
  let mtime: number | null = null
  try {
    mtime = (await fsp.stat(dbPath)).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { available: false, reason: "opencode.db not found" }
    mtime = null
  }
  const key = mtime === null ? null : `${sessionID}:${mtime}`
  const cached = key === null ? undefined : cache.get(key)
  if (cached) return { available: true, usage: cached }

  const sqlite = await loadSqlite()
  if (!sqlite) return { available: false, reason: "opencode.db history needs Node 22.5+ (node:sqlite)" }

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare("SELECT data FROM message WHERE sessionID = ?").all(sessionID) as { data?: string }[]
      let tokens: StageTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      let cost = 0
      let messages = 0
      for (const row of rows) {
        if (!row.data) continue
        let parsed: {
          role?: string
          cost?: number
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        }
        try {
          parsed = JSON.parse(row.data)
        } catch {
          continue
        }
        if (parsed.role !== "assistant" || !parsed.tokens) continue
        messages++
        cost += parsed.cost ?? 0
        tokens = {
          input: tokens.input + (parsed.tokens.input ?? 0),
          output: tokens.output + (parsed.tokens.output ?? 0),
          reasoning: tokens.reasoning + (parsed.tokens.reasoning ?? 0),
          cacheRead: tokens.cacheRead + (parsed.tokens.cache?.read ?? 0),
          cacheWrite: tokens.cacheWrite + (parsed.tokens.cache?.write ?? 0),
        }
      }
      const usage: SessionUsage = { tokens, cost, messages }
      if (key !== null) remember(key, usage)
      return { available: true, usage }
    } finally {
      db.close()
    }
  } catch (err) {
    return { available: false, reason: `opencode.db query failed: ${(err as Error).message}` }
  }
}
