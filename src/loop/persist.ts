import type { PluginInput } from "@opencode-ai/plugin"
import path from "node:path"
import { z } from "zod"
import { STAGES, type LoopState } from "./state.ts"

/**
 * Durable snapshots of a task-driven loop's `LoopState`, so a crash or opencode
 * restart mid-loop resumes at the exact stage with artifacts intact instead of
 * re-planning from the persisted plan. **Impure** (fs via the client + Bun `$`);
 * `state.ts` stays pure. Snapshots are ephemeral machine state — gitignored,
 * unlike the durable `runs/*.md` logs. See docs/design/improvements/02.
 *
 * The snapshot lives in the repo working tree, so `load` **validates and fails
 * closed**: a garbled or tampered file returns null (→ plan-based recovery),
 * never injects arbitrary state.
 *
 * Snapshots written before the PLAN stage was removed (stage "plan", or with a
 * `paused` flag) are deliberately invalidated by the schema below — they fail
 * closed and `/agent-loop recover` falls back to the plan persisted on the task file.
 */

type Client = PluginInput["client"]
type Shell = PluginInput["$"]

const GitRefSchema = z.object({
  base: z.string(),
  branch: z.string(),
  worktree: z.string().optional(),
})

const TaskRefSchema = z.object({
  id: z.string(),
  path: z.string(),
  acceptance: z.array(z.string()),
})

const LoopStateSchema = z.object({
  goal: z.string(),
  stage: z.enum(STAGES as unknown as [string, ...string[]]),
  iteration: z.number().int().min(0),
  // Partial map of stage → captured output. String keys (not an enum) because
  // this zod version treats an enum-keyed record as exhaustive; the state
  // machine only ever reads known stage keys, so extra keys are inert.
  artifacts: z.record(z.string(), z.string()).default({}),
  task: TaskRefSchema.optional(),
  git: GitRefSchema.optional(),
})

/** Absolute path of a task's state snapshot. Pure. */
export const statePath = (directory: string, tasksDir: string, id: string): string =>
  path.join(directory, tasksDir, "runs", `${id}.state.json`)

/** Write a snapshot of the loop state. Best-effort — never fails the drive over telemetry. */
export const saveState = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  id: string,
  state: LoopState,
): Promise<void> => {
  const dir = path.join(directory, tasksDir, "runs")
  await $`mkdir -p ${dir}`.quiet().nothrow()
  const file = statePath(directory, tasksDir, id)
  await $`printf '%s' ${JSON.stringify(state, null, 2)} > ${file}`.quiet().nothrow()
}

/** Load and validate a snapshot; null on absent, unreadable, invalid JSON, or schema failure. */
export const loadState = async (
  client: Client,
  directory: string,
  tasksDir: string,
  id: string,
): Promise<LoopState | null> => {
  const rel = `${tasksDir}/runs/${id}.state.json`
  const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  const result = LoopStateSchema.safeParse(raw)
  return result.success ? (result.data as LoopState) : null
}

/** Remove a task's snapshot. Best-effort; idempotent on an absent file. */
export const clearState = async ($: Shell, directory: string, tasksDir: string, id: string): Promise<void> => {
  await $`rm -f ${statePath(directory, tasksDir, id)}`.quiet().nothrow()
}

/** Task ids that have a state snapshot on disk (a strong "resume me" signal). `[]` if none. */
export const listSnapshotIds = async (client: Client, directory: string, tasksDir: string): Promise<string[]> => {
  const rel = `${tasksDir}/runs`
  try {
    const res = await client.file.list({ query: { path: rel, directory } })
    return (res.data ?? [])
      .filter((n) => n.type === "file" && n.name.endsWith(".state.json"))
      .map((n) => n.name.replace(/\.state\.json$/, ""))
  } catch {
    return []
  }
}
