import type { Log, Shell } from "../host.js"
import { CONFIG_FILE } from "../config-layers.js"
import { STATUSES } from "../task/statuses.js"
import type { Config } from "./state.js"
import { ensureExcluded, isGitRepo } from "./git.js"

/**
 * The `init` verb's one-shot scaffolding — the setup that otherwise happens
 * lazily and invisibly. Nothing here is REQUIRED for the loop to run: status
 * folders appear on first write (`moveTask`/`createTask` mkdir at the point of
 * use), the repo config is optional (defaults apply), and the backlog exclude
 * is ensured at every claim. What `init` buys is that a human setting up a new
 * repo sees the structure on day one instead of discovering it piecemeal —
 * and gets a repo config file to edit instead of a filename to remember.
 *
 * Two rules carry it:
 *
 *  - **Idempotent, and never overwrites.** Every step is create-if-absent;
 *    re-running reports what already existed (`kept`) and changes nothing.
 *    An existing `.agentic-workflow.json` — however partial — is the human's,
 *    and "init fixed my config" is a bug report waiting to happen.
 *  - **Safe keys only in the skeleton.** The written config carries defaults
 *    for repo-appropriate keys (`tasksDir`, `maxIterations`) and nothing
 *    shell-bearing or credential-shaped: those are user-layer-only
 *    (`droppedRepoKeys`), so writing them here would scaffold a file the
 *    runtime immediately warns about.
 */

/** What the skeleton repo config contains — defaults made visible, safe keys only. */
export const initConfigSkeleton = (config: Config): string =>
  `${JSON.stringify({ tasksDir: config.tasksDir, maxIterations: config.maxIterations }, null, 2)}\n`

export interface InitReport {
  /** Status folders this run created (relative to the repo root). */
  readonly createdDirs: readonly string[]
  /** Whether the repo config file was written (false ⇒ it already existed, or the write failed). */
  readonly configCreated: boolean
  readonly configPath: string
  /** What already existed and was left untouched. */
  readonly kept: readonly string[]
  /** Whether the backlog is git-excluded (`ignoreBacklog`); null when not a git repo or not asked. */
  readonly excluded: boolean | null
  /** The one-line summary a host surfaces. */
  readonly message: string
}

/** `test -e`, over the host shell so the fake-shell tests can model it. */
const exists = async ($: Shell, path: string): Promise<boolean> => (await $`test -e ${path}`.quiet().nothrow()).exitCode === 0

/**
 * Scaffold the backlog folders and (when absent) a safe-key repo config.
 * Best-effort throughout: a failed step is reported, never thrown — `init`
 * must be safe to run on any repo in any state.
 */
export const initRepo = async ($: Shell, directory: string, config: Config, log?: Log): Promise<InitReport> => {
  const createdDirs: string[] = []
  const kept: string[] = []
  for (const status of STATUSES) {
    const rel = `${config.tasksDir}/${status}`
    const abs = `${directory}/${rel}`
    if (await exists($, abs)) {
      kept.push(`${rel}/`)
      continue
    }
    const made = await $`mkdir -p ${abs}`.quiet().nothrow()
    if (made.exitCode === 0) createdDirs.push(`${rel}/`)
    else log?.("warn", `init: could not create ${rel}/ — ${made.stderr.toString().trim() || "mkdir failed"}`)
  }

  const configPath = `${directory}/${CONFIG_FILE}`
  let configCreated = false
  if (await exists($, configPath)) {
    kept.push(CONFIG_FILE)
  } else {
    const wrote = await $`printf '%s' ${initConfigSkeleton(config)} > ${configPath}`.quiet().nothrow()
    configCreated = wrote.exitCode === 0
    if (!configCreated) log?.("warn", `init: could not write ${CONFIG_FILE} — ${wrote.stderr.toString().trim() || "write failed"}`)
  }

  // The default `ignoreBacklog: true` keeps the backlog out of git via
  // `<git-common-dir>/info/exclude`; every claim ensures it, but doing it here
  // means the very first `git status` after init is already clean.
  let excluded: boolean | null = null
  if (config.ignoreBacklog && (await isGitRepo($, directory))) {
    await ensureExcluded($, directory, config.tasksDir)
    excluded = true
  }

  const parts = [
    createdDirs.length ? `created ${createdDirs.length} status folder${createdDirs.length === 1 ? "" : "s"} under ${config.tasksDir}/` : `${config.tasksDir}/ already set up`,
    configCreated ? `wrote ${CONFIG_FILE} (safe defaults — edit it, or delete it to run on defaults alone)` : kept.includes(CONFIG_FILE) ? `${CONFIG_FILE} kept as-is` : `${CONFIG_FILE} not written`,
    ...(excluded ? [`backlog git-excluded (ignoreBacklog)`] : []),
  ]
  return {
    createdDirs,
    configCreated,
    configPath: CONFIG_FILE,
    kept,
    excluded,
    message: `Init: ${parts.join("; ")}. Next: /agentic-workflow:engineering new <idea> drafts the first task.`,
  }
}
