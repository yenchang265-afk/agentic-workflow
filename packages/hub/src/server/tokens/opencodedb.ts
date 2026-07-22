import fs from "node:fs"
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

const cache = new Map<string, SessionUsage>()

export const readSessionUsage = async (dbPath: string, sessionID: string): Promise<DbResult> => {
  if (!fs.existsSync(dbPath)) return { available: false, reason: "opencode.db not found" }
  const key = `${sessionID}:${(() => {
    try {
      return fs.statSync(dbPath).mtimeMs
    } catch {
      return 0
    }
  })()}`
  const cached = cache.get(key)
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
      cache.set(key, usage)
      return { available: true, usage }
    } finally {
      db.close()
    }
  } catch (err) {
    return { available: false, reason: `opencode.db query failed: ${(err as Error).message}` }
  }
}
