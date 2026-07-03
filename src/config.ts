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
  /** Pause for human approval after plan, before build edits anything. */
  gateBeforeBuild: z.boolean().default(true),
  /**
   * Whether a free-text `/loop <goal>` may run a live `interview-me` pass on
   * an underspecified goal before queuing the automatic pipeline. Read by
   * the `/loop` command's own prompt (`.opencode/commands/loop.md`), not
   * branched on in plugin code — validated here so a typo'd value fails
   * fast like every other knob.
   */
  interviewBeforePlan: z.boolean().default(true),
  /** Repo-relative root of the task backlog; its subfolders are task statuses. */
  tasksDir: z.string().min(1).default("docs/tasks"),
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
