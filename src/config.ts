import type { PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import type { Config } from "./loop/state.ts"

/**
 * Loop configuration, read from `.agentic-loop.json` at the repo root via the
 * opencode client (no Node fs dependency). The file is optional; every field has
 * a sane default. Misconfiguration fails fast with a clear message rather than
 * silently falling back to defaults.
 */

type Client = PluginInput["client"]

const ConfigSchema = z.object({
  /** Max loop iterations before stopping on repeated verify/review failures. */
  maxIterations: z.number().int().positive().default(3),
  /** Repo-relative root of the task backlog; its subfolders are task statuses. */
  tasksDir: z.string().min(1).default("docs/tasks"),
  /** Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. */
  stageTimeoutMinutes: z.number().int().positive().default(60),
  /**
   * Default polling cadence for `/agent-loop watch`: a timer at this interval scans
   * `in-progress/` for claimable approved tasks while the session is idle.
   * Overridable per-session via `/agent-loop watch <interval>` (e.g. `30s`, `2h`).
   */
  watchIntervalMinutes: z.number().positive().max(1440).default(5),
  /**
   * Repo-relative (or absolute) directory for per-task git worktrees. When set,
   * each loop's BUILD/VERIFY/REVIEW runs against its own worktree instead of
   * switching branches in the shared checkout — the human's tree is never
   * touched and concurrent watch sessions become safe. Unset → today's
   * shared-tree branch switching. See docs/design/improvements/01.
   */
  worktreesDir: z.string().min(1).optional(),
  /** Optional shell command run inside a freshly created worktree (e.g. "npm ci"). */
  worktreeSetup: z.string().min(1).optional(),
  /**
   * Extra REVIEW lenses; each runs the review stage once more focused on that
   * lens, and the loop takes the worst verdict across all passes. Unset/[] →
   * a single review (today's behavior). See docs/design/improvements/04.
   */
  reviewLenses: z.array(z.string().min(1)).max(5).default([]),
})

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

const CONFIG_FILE = ".agentic-loop.json"

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => {
  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`Invalid ${CONFIG_FILE}: ${detail}`)
  }
  return result.data
}

/** Load config from the repo root, falling back to defaults when the file is absent. */
export const loadConfig = async (client: Client, directory: string): Promise<Config> => {
  const res = await client.file.read({ query: { path: CONFIG_FILE, directory } })
  const content = res.data?.content
  if (!content) return DEFAULT_CONFIG // absent/empty → defaults
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_FILE}: not valid JSON (${(err as Error).message})`)
  }
  return parseConfig(json)
}
