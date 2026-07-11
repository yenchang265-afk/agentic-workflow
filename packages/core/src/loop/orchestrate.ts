import type { Client, Log, Shell } from "../host.js"
import { enabledLoopKinds, platformFor } from "../config.js"
import { loadManifest } from "../manifest/load.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { makeAdoPrSource } from "../source/ado-pr.js"
import { makeBacklogSource } from "../source/backlog.js"
import { makeGithubPrSource } from "../source/github-pr.js"
import type { WorkSource } from "../source/types.js"
import type { Task } from "../task/schema.js"
import { extractPlan } from "../task/store.js"
import type { Config, LoopState, TaskRef } from "./state.js"
import { resumeAtBuild, startAtPlan } from "./state.js"

/**
 * Host-agnostic orchestration helpers shared by the two drivers — the
 * OpenCode plugin (`plugins/opencode/src/loop/driver.ts`) and the Claude Code
 * MCP server (`plugins/claude/mcp-server/src/server.ts`). Each was hand-
 * porting these between the two files; this module is the single copy,
 * parameterized over the `host.ts` interfaces.
 */

/** A task's goal text: title headline plus its body, if any. Pure. */
export const taskGoal = (task: Task): string => (task.body ? `${task.title}\n\n${task.body}` : task.title)

/** The reference a loop state carries for its backing task file. Pure. */
export const taskRef = (task: Task, filePath: string): TaskRef => ({
  id: task.id,
  path: filePath,
  acceptance: task.acceptance,
})

/** The working directory a loop's stages operate in: its worktree, else the main tree. Pure. */
export const loopWorkTree = (directory: string, state: LoopState): string => state.git?.worktree ?? directory

/** BUILD-entry state for an approved in-progress task (plan persisted on the file). Pure. */
export const buildEntryState = (task: Task): LoopState => resumeAtBuild(taskGoal(task), taskRef(task, task.path), extractPlan(task) ?? "")

/** PLAN-entry state for a queued (planless) task. Pure. */
export const planEntryState = (task: Task): LoopState => startAtPlan(taskGoal(task), taskRef(task, task.path), extractPlan(task))

/**
 * A lazily-loading manifest cache keyed by loop kind. Eager kinds (usually
 * just "engineering") are loaded up front so a broken default manifest fails
 * at startup, not on first claim.
 */
export const makeManifestCache = (loopsDir: string, eager: readonly string[] = []): ((kind: string) => LoadedManifest) => {
  const manifests = new Map<string, LoadedManifest>()
  for (const kind of eager) manifests.set(kind, loadManifest(loopsDir, kind))
  return (kind) => {
    let loaded = manifests.get(kind)
    if (!loaded) {
      loaded = loadManifest(loopsDir, kind)
      manifests.set(kind, loaded)
    }
    return loaded
  }
}

/** Everything `buildWorkSources` needs from the host. */
export interface WorkSourceDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly log: Log
  /** Whether a live loop in this process is already driving the task id. */
  readonly isDriving: (id: string) => boolean
}

/**
 * The work sources the scheduler polls, in claim-priority order (config
 * order). An `only` kind restricts the poll to that one kind (the claim/watch
 * kind filter). A typo'd or unavailable `loops.<kind>` (the config schema is
 * an open record) must not throw here — that would abort the whole build and
 * take every OTHER enabled source (engineering included) down with it, so no
 * work ever gets claimed. Skip-and-warn the bad kind instead.
 */
export const buildWorkSources = (
  deps: WorkSourceDeps,
  config: Config,
  manifestFor: (kind: string) => LoadedManifest,
  only?: string,
): WorkSource[] =>
  enabledLoopKinds(config)
    .filter((kind) => !only || kind === only)
    .flatMap((kind): WorkSource[] => {
      let loaded: LoadedManifest
      try {
        loaded = manifestFor(kind)
      } catch (err) {
        void deps.log(
          "warn",
          `loop kind "${kind}" is enabled in config but its loops/${kind}/ manifest could not be loaded — skipping it. ${(err as Error).message}`,
        )
        return []
      }
      const base = {
        $: deps.$,
        client: deps.client,
        directory: deps.directory,
        tasksDir: config.tasksDir,
        log: deps.log,
        loaded,
      }
      if (loaded.manifest.workSource.type === "github-pr") {
        if (platformFor(config, kind) === "ado") {
          // Config parse fails fast when platform "ado" lacks the ado section.
          return [makeAdoPrSource({ ...base, ado: config.ado! })]
        }
        const query = config.loops[kind]?.["query"]
        return [makeGithubPrSource({ ...base, ...(typeof query === "string" ? { query } : {}) })]
      }
      return [makeBacklogSource({ ...base, isDriving: deps.isDriving })]
    })
