import fs from "node:fs"
import path from "node:path"

/**
 * Reading the live stage marker the MCP server writes.
 *
 * Shared by the PreToolUse guard and the spawn-model stamp. The marker is how a
 * hook learns anything the MANIFEST knows: `packages/core/src/manifest/dir.ts`
 * resolves the workflows dir from `import.meta.url`, and `scripts/build-hooks.mjs`
 * inlines core into each bundle, so that walk lands on the hook's own directory.
 * Manifest loading from a hook is broken by construction — which is why the
 * server resolves manifest-derived facts (the bash allowlist, the stage agent,
 * the stage models) and parks them here instead.
 *
 * Dependency-free (fs + path) so it bundles into any hook.
 */

/** tasksDir defaults to docs/tasks; honor .agentic-workflow.json if present. */
export const readTasksDir = (cwd) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-workflow.json"), "utf8"))
    if (typeof cfg.tasksDir === "string" && cfg.tasksDir) return cfg.tasksDir
  } catch {
    /* default */
  }
  return "docs/tasks"
}

/** The active stage marker, or null when no loop is live (or it is unreadable). */
export const readMarker = (cwd, tasksDir, markerFile) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, tasksDir, "runs", markerFile), "utf8"))
  } catch {
    return null
  }
}
