import path from "node:path"
import { writeFileAtomic } from "../fsatomic.js"
import type { Client, Log, Shell } from "../host.js"
import { z } from "zod"
import { isSafeTaskId, SAFE_TASK_ID_RE } from "../task/schema.js"
import { CODE_PLATFORMS, STAGES, type WorkflowState } from "./state.js"

/**
 * Durable snapshots of a task-driven loop's `WorkflowState`, so a crash or opencode
 * restart mid-loop resumes at the exact stage with artifacts intact instead of
 * re-planning from the persisted plan. **Impure** (fs via the client + Bun `$`);
 * `state.ts` stays pure. Snapshots are ephemeral machine state — gitignored,
 * unlike the durable `runs/*.md` logs. See docs/design/improvements/02.
 *
 * The snapshot lives in the repo working tree, so `load` **validates and fails
 * closed**: a garbled or tampered file returns null (→ plan-based recovery),
 * never injects arbitrary state.
 *
 * A snapshot at stage "plan" is deliberately invalidated by the schema below:
 * the PLAN stage never snapshots (it writes no code — a died PLAN is
 * recovered by the stale claim-marker sweep, and the next pass re-plans from
 * the task file). Any such snapshot is either pre-refactor state or tampering
 * — it fails closed and `/agentic-workflow:engineering recover` falls back to the plan persisted on
 * the task file.
 */

const GitRefSchema = z.object({
  base: z.string(),
  branch: z.string(),
  worktree: z.string().optional(),
  /**
   * Must be listed here at all because zod STRIPS unknown keys — the same trap
   * `claimMarkerDir` documents below. Without it a snapshot-resumed
   * current-branch run silently loses the flag, and `teardownIsolation` then
   * reads its sha `base` as a branch and checks the human out onto it.
   * Optional for the fail-closed reason `feedback` gives: a required field
   * would invalidate every snapshot written before this existed.
   */
  onCurrentBranch: z.literal(true).optional(),
})

const TaskRefSchema = z.object({
  // The id from a snapshot reaches `statePath`/`rm -f` and task-file paths — a
  // tampered `../…` id must fail the schema, not traverse out of the backlog.
  id: z.string().regex(SAFE_TASK_ID_RE),
  path: z.string(),
  acceptance: z.array(z.string()),
})

/** The engineering stages a snapshot may resume at — every stage except `plan` (see module doc). */
export const SNAPSHOT_STAGES: readonly string[] = STAGES.filter((s) => s !== "plan")

const WorkflowStateSchema = z.object({
  kind: z.string().min(1).optional(),
  goal: z.string(),
  stage: z.string().min(1),
  iteration: z.number().int().min(0),
  // Partial map of stage → captured output. String keys (not an enum) because
  // this zod version treats an enum-keyed record as exhaustive; the state
  // machine only ever reads known stage keys, so extra keys are inert.
  artifacts: z.record(z.string(), z.string()).default({}),
  /**
   * Seam between each artifact's structured verdict block and its prose, so a
   * resumed run's context budget still spares the block. **Optional**, because
   * `loadState` fails closed on a schema mismatch — a required field would
   * invalidate every snapshot written before this existed. A snapshot without it
   * resumes with the whole artifact subject to the budget: lossy, never missing.
   */
  feedback: z.record(z.string(), z.string()).optional(),
  /**
   * Bounded iteration ledger. Optional for the same fail-closed reason as
   * `feedback`: a resumed run without it simply has no memory of earlier
   * attempts, which is what every pre-upgrade snapshot has.
   */
  attempts: z
    .array(
      z.object({
        stage: z.string().min(1),
        iteration: z.number().int().min(0),
        verdict: z.enum(["PASS", "FAIL", "ERROR"]),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  task: TaskRefSchema.optional(),
  /**
   * A task-less drive's claim-marker path, restamped at stage boundaries
   * (`refreshWorkClaim`). Optional for the fail-closed reason above — and it
   * must be listed here at all because zod STRIPS unknown keys: without it a
   * resumed sitter drive silently loses the restamp and reads stale mid-run.
   */
  claimMarkerDir: z.string().optional(),
  git: GitRefSchema.optional(),
  /** Code platform stamped by the claiming work source; absent (old snapshots) ⇒ github. */
  platform: z.enum(CODE_PLATFORMS).optional(),
})

/** Absolute path of a task's state snapshot. Pure. */
export const statePath = (directory: string, tasksDir: string, id: string): string =>
  path.join(directory, tasksDir, "runs", `${id}.state.json`)

/**
 * Write a snapshot of the loop state. Best-effort — never fails the drive over
 * telemetry — but never SILENT either: a dropped snapshot is why a later
 * `recover` degrades to plan-based recovery, and without this warning there is
 * nothing anywhere to explain it. Pass `log` to hear about it.
 */
export const saveState = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  id: string,
  state: WorkflowState,
  log?: Log,
): Promise<void> => {
  const dir = path.join(directory, tasksDir, "runs")
  await $`mkdir -p ${dir}`.quiet().nothrow()
  const file = statePath(directory, tasksDir, id)
  const wrote = await writeFileAtomic($, file, JSON.stringify(state, null, 2))
  if (wrote.exitCode !== 0 && log) {
    await log("warn", `loop(${id}): state snapshot not written (${wrote.stderr.toString().trim() || `exit ${wrote.exitCode}`}) — recover will fall back to the plan on the task file`)
  }
}

/**
 * Load and validate a snapshot; null on absent, unreadable, invalid JSON, or
 * schema failure. `resumableStages` is the workflow kind's set of stages a
 * snapshot may resume at (its isolated stages); a snapshot at any other stage
 * fails closed — see the module doc.
 */
export const loadState = async (
  client: Client,
  directory: string,
  tasksDir: string,
  id: string,
  resumableStages: readonly string[] = SNAPSHOT_STAGES,
): Promise<WorkflowState | null> => {
  if (!isSafeTaskId(id)) return null // fail closed — id feeds a path below
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
  const result = WorkflowStateSchema.safeParse(raw)
  if (!result.success || !resumableStages.includes(result.data.stage)) return null
  return result.data as WorkflowState
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
