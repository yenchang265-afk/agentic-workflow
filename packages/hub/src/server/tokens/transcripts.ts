import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import type { UsageRecord } from "./attribute.js"

/**
 * Claude Code transcript reader. Sessions live at
 * `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`; assistant records
 * carry `message.usage` totals and an ISO `timestamp`. Files are streamed
 * line by line (never JSON.parsed whole) and results cached by (path, size)
 * so repeated attribution over a run list parses each file once.
 */

/** Claude Code's project-directory slug for a working directory. */
export const projectSlug = (directory: string): string => directory.replace(/[^a-zA-Z0-9-]/g, "-")

export const defaultProjectsDir = (): string => path.join(os.homedir(), ".claude", "projects")

const cache = new Map<string, { size: number; records: UsageRecord[] }>()

const readFileRecords = async (file: string): Promise<UsageRecord[]> => {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return []
  }
  const cached = cache.get(file)
  if (cached && cached.size === size) return cached.records

  const records: UsageRecord[] = []
  const stream = fs.createReadStream(file, { encoding: "utf8" })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"usage"')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const rec = parsed as {
        timestamp?: string
        message?: {
          model?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
      }
      const usage = rec.message?.usage
      const atMs = rec.timestamp ? Date.parse(rec.timestamp) : NaN
      if (!usage || Number.isNaN(atMs)) continue
      records.push({
        atMs,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        ...(rec.message?.model ? { model: rec.message.model } : {}),
      })
    }
  } catch {
    // truncated/rotating file — keep what we parsed
  }
  cache.set(file, { size, records })
  return records
}

/**
 * Every usage record for a project directory within [fromMs, toMs]. Files
 * whose mtime predates `fromMs` can't contain later records and are skipped.
 * Missing projects dir → `[]`, never an error.
 */
export const readUsageRecords = async (
  projectsDir: string,
  directory: string,
  fromMs: number,
  toMs: number,
): Promise<UsageRecord[]> => {
  const dir = path.join(projectsDir, projectSlug(directory))
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  } catch {
    return []
  }
  const out: UsageRecord[] = []
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).mtimeMs < fromMs) continue
    } catch {
      continue
    }
    const records = await readFileRecords(file)
    for (const r of records) if (r.atMs >= fromMs && r.atMs <= toMs) out.push(r)
  }
  return out
}
