import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Where the hooks look for the backlog — resolved the SAME way the MCP server
 * resolves it when it WRITES there.
 *
 * The two disagreed. The server roots the backlog at
 * `AGENTIC_WORKFLOW_DIR ?? process.cwd()` and reads `tasksDir` through
 * `loadConfig`, which merges the user-scope layer under the repo file. The
 * guards read only `<input.cwd>/.agentic-workflow.json`. So a `tasksDir` set in
 * the user-scope config (a documented layer — `verb-slice.mjs` and
 * `inject-ado-pat.mjs` both read it), a session started in a subdirectory, or an
 * `AGENTIC_WORKFLOW_DIR` pointing elsewhere all made the guard look for the
 * stage marker somewhere the server never writes one.
 *
 * A missing marker means "no loop stage is running", which is the ordinary case
 * for an ordinary session — so the guards allow, correctly. That fail-open is
 * the design; the bug was that a resolution mismatch made a LIVE stage look like
 * no stage at all, taking the VERIFY/REVIEW allowlist, the worktree pin and the
 * stage deadline down with it while every layer reported success.
 *
 * Duplicated from core rather than imported: these hooks are bundled to run
 * under bare `node` from a copied plugin dir, and core's own loader is async and
 * needs a host `Client`. Kept in one module so the two guards cannot drift from
 * each other the way they drifted from the server.
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
 * The repo root the backlog hangs off. `AGENTIC_WORKFLOW_DIR` wins, exactly as
 * it does in the MCP server, so a session launched from a subdirectory still
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
