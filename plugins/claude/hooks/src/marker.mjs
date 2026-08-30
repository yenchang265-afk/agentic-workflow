import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Reading the live stage marker the MCP server writes.
 *
 * Shared by the PreToolUse guard, the SubagentStop verdict guard, the spawn-model
 * stamp and the SessionStart reconciler. The marker is how a hook learns anything
 * the MANIFEST knows: `packages/core/src/manifest/dir.ts` resolves the workflows
 * dir from `import.meta.url`, and `scripts/build-hooks.mjs` inlines core into each
 * bundle, so that walk lands on the hook's own directory. Manifest loading from a
 * hook is broken by construction — which is why the server resolves
 * manifest-derived facts (the bash allowlist, the stage agent, the stage models)
 * and parks them here instead.
 *
 * Everything here resolves the backlog the SAME way the server resolves it when
 * it WRITES there. The two used to disagree: the server roots the backlog at
 * `AGENTIC_WORKFLOW_DIR ?? process.cwd()` and reads `tasksDir` through
 * `loadConfig`, which merges the user-scope layer under the repo file, while this
 * module read only `<cwd>/.agentic-workflow.json`. Wherever they differed — a
 * `tasksDir` in the user-scope config (a documented layer that `verb-slice.mjs`
 * and `inject-ado-pat.mjs` already read), a session started in a subdirectory, an
 * `AGENTIC_WORKFLOW_DIR` pointing elsewhere — `readMarker` returned null and the
 * guard's `if (!marker) return allow()` ran BEFORE the deadline check, the
 * worktree pin and the VERIFY/REVIEW default-deny allowlist. A live check stage
 * then ran with unrestricted Bash while every layer reported success.
 *
 * That fail-open is correct and stays: no marker legitimately means no loop
 * stage, the ordinary case for an ordinary session. The bug was that a resolution
 * mismatch made a LIVE stage look like no stage at all.
 *
 * Dependency-free (fs + os + path) so it bundles into any hook; the layering is
 * duplicated from core rather than imported because core's own loader is async
 * and needs a host `Client`.
 */

/** The user-scope config path, mirroring core's `resolveUserConfigPath`. */
export const userConfigPath = () => {
  const env = process.env.AGENTIC_WORKFLOW_USER_CONFIG
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  if (!home) return null
  const xdg = process.env.XDG_CONFIG_HOME?.trim() ? process.env.XDG_CONFIG_HOME : path.join(home, ".config")
  const primary = path.join(xdg, "agentic-workflow", "agentic-workflow.json")
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, ".agentic-workflow.json")
  return fs.existsSync(legacy) ? legacy : primary
}

/** A config layer's parsed object, or null — unreadable or malformed is "no config", never an error. */
const layer = (file) => {
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/**
 * The repo root the backlog hangs off. `AGENTIC_WORKFLOW_DIR` wins, exactly as it
 * does in the MCP server, so a session launched from a subdirectory still
 * resolves the same backlog the server writes to.
 */
export const backlogRoot = (cwd) => process.env.AGENTIC_WORKFLOW_DIR || cwd || process.cwd()

/**
 * The configured `tasksDir` for `root`: the repo layer over the user layer, the
 * same precedence `mergeConfigLayers` applies. Defaults to `docs/tasks`.
 */
export const readTasksDir = (root) => {
  const repo = layer(path.join(root, ".agentic-workflow.json"))
  if (typeof repo?.tasksDir === "string" && repo.tasksDir) return repo.tasksDir
  const user = layer(userConfigPath())
  if (typeof user?.tasksDir === "string" && user.tasksDir) return user.tasksDir
  return "docs/tasks"
}

/** The absolute `runs/` directory the stage marker and verdict sentinel live in. */
export const runsDir = (cwd) => {
  const root = backlogRoot(cwd)
  return path.join(root, readTasksDir(root), "runs")
}

/** The active stage marker, or null when no loop is live (or it is unreadable). */
export const readMarker = (cwd, markerFile) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir(cwd), markerFile), "utf8"))
  } catch {
    return null
  }
}

/**
 * This machine's identity, the sync twin of core's `machineId` — hostname plus
 * boot id, because two containers from one image commonly share a hostname
 * while having SEPARATE pid namespaces. Duplicated from core rather than
 * imported for the same reason everything else here is: core's own readers are
 * async and take a host `Shell`.
 */
export const machineIdSync = () => {
  let boot = ""
  try {
    boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    /* no /proc — the token degrades to the hostname, and a boot-id stamp then mismatches, which is the safe direction */
  }
  return { host: os.hostname(), boot: boot.length > 0 ? boot : null }
}

/**
 * Whether a stamped `{host, boot}` names the machine we are running on. Fails
 * CLOSED on every uncertainty — no host, a mismatch, or a boot id present on
 * one side only. The twin of core's `isSameMachine`; see there for why each
 * arm is a refusal. Pure.
 */
export const isSameMachine = (stamped, self) => {
  if (!stamped || typeof stamped !== "object") return false
  if (typeof stamped.host !== "string" || stamped.host !== self.host) return false
  const stampedBoot = typeof stamped.boot === "string" && stamped.boot.length > 0 ? stamped.boot : null
  return stampedBoot === self.boot
}

/**
 * Whether the marker's writer is PROVABLY a live process here. Feeds the
 * check-stage-guard's deadline starve: a stage past its deadline is starved of
 * guarded tools only while the loop that armed it is still running — a dead
 * writer's marker is a crashed run's leftover (nothing removes the file on a
 * SIGKILL/OOM/sleep), and blocking on it ruled the repo forever.
 *
 * This is the reading that ENFORCES, which is the opposite direction to core's
 * `pidAlive` callers (they only ever relax a guard on a false reading, which is
 * what `liveness.ts` blesses the bare probe for). So aliveness needs proof, and
 * every uncertainty answers "not alive":
 *
 * - **The pid needs its namespace.** A bind-mounted repo or sibling containers
 *   share this marker directory while having separate pid namespaces, so a
 *   crashed writer's pid can exist here and read live — the wedge
 *   `dead-marker.test.mjs` shipped to end, reopened one environment over. A
 *   marker with no `machine` stamp (an older server) cannot be proven local.
 * - **The probe is SELF-VALIDATING.** It must see our OWN pid first, or it
 *   proves nothing about anyone else's — a sandbox where `kill` is refused
 *   outright would otherwise report every pid alive.
 * - **EPERM still means alive**: the process exists, owned by another user.
 */
export const markerWriterAlive = (marker) => {
  const pid = marker?.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  if (!isSameMachine(marker?.machine, machineIdSync())) return false
  const probe = (target) => {
    try {
      process.kill(target, 0)
      return true
    } catch (err) {
      return err?.code === "EPERM"
    }
  }
  if (!probe(process.pid)) return false
  return probe(pid)
}

/**
 * The marker as every marker-scoped control must read it: null once it is a
 * CRASHED run's leftover — past its deadline with no provably live writer.
 *
 * One helper because the rule is one rule: it was written in check-stage-guard
 * alone, so `check-evidence` (which gates on `check === true` and nothing else)
 * kept appending to a dead stage's ledger from every later session, and
 * `decideSpawnGuard`'s docstring claimed "the same liveness rule" while
 * implementing a weaker one. A marker with no deadline (an older server) stays
 * trusted, and one whose writer is alive keeps enforcing however late it is.
 */
export const liveMarker = (marker, now = Date.now()) =>
  marker && typeof marker.deadline === "number" && now > marker.deadline && !markerWriterAlive(marker) ? null : marker
