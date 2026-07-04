import type { Client } from "../shim.js"
import { z } from "zod"
import type { Config } from "./loop/state.js"

/**
 * Loop configuration, read from `.agentic-loop.json` at the repo root via the
 * opencode client (no Node fs dependency). The file is optional; every field has
 * a sane default. Misconfiguration fails fast with a clear message rather than
 * silently falling back to defaults.
 */


const ConfigSchema = z.object({
  /** Max loop iterations before stopping on repeated verify/review failures. */
  maxIterations: z.number().int().positive().default(3),
  /** Pause for human approval after plan, before build edits anything. */
  gateBeforeBuild: z.boolean().default(true),
  /**
   * Whether a free-text `/agent-loop <goal>` may run a live `interview-me` pass on
   * an underspecified goal before queuing the automatic pipeline. Read by
   * the `/agent-loop` command's own prompt (`.opencode/commands/agent-loop.md`), not
   * branched on in plugin code — validated here so a typo'd value fails
   * fast like every other knob.
   */
  interviewBeforePlan: z.boolean().default(true),
  /** Repo-relative root of the task backlog; its subfolders are task statuses. */
  tasksDir: z.string().min(1).default("docs/tasks"),
  /** Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. */
  stageTimeoutMinutes: z.number().int().positive().default(60),
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
