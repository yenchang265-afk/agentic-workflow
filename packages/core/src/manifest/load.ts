import fs from "node:fs"
import path from "node:path"
import { parseManifest, type LoadedManifest, type WorkflowManifest } from "./schema.js"

/**
 * Load workflow-kind manifests from a `workflows/` directory:
 *
 *   workflows/<kind>/workflow.json      — the manifest (schema.ts)
 *   workflows/<kind>/stages/*.md    — per-stage prompt templates (template.ts)
 *
 * Loading is synchronous, once, at host startup — manifests are plugin
 * assets, not runtime state. A malformed manifest throws with the offending
 * path so a broken workflow kind fails loud instead of driving garbage.
 */

/**
 * Work-source type names that were renamed after release, mapped old → new.
 * User-authored manifests in the wild still carry the old spelling, so it stays
 * a supported alias rather than a schema error — silently, not with a warning,
 * because the hub's Config tab round-trips manifests through this loader.
 */
const LEGACY_SOURCE_TYPES: Readonly<Record<string, string>> = { "github-pr": "pull-request" }

/**
 * Rewrite legacy `workSource.type` spellings to their current names, before the
 * schema sees them. Input is unvalidated JSON, so every shape assumption is
 * checked — anything that isn't the exact shape we rewrite is passed through
 * untouched for zod to reject with its own message.
 */
export const normalizeManifestJson = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  const { workSource } = raw as { workSource?: unknown }
  if (typeof workSource !== "object" || workSource === null || Array.isArray(workSource)) return raw
  const { type } = workSource as { type?: unknown }
  if (typeof type !== "string") return raw
  const renamed = LEGACY_SOURCE_TYPES[type]
  if (!renamed) return raw
  return { ...raw, workSource: { ...workSource, type: renamed } }
}

/** Load one workflow kind's manifest + stage prompts. Throws on missing/invalid files. */
export const loadManifest = (workflowsDir: string, kind: string): LoadedManifest => {
  const dir = path.join(workflowsDir, kind)
  const manifestPath = path.join(dir, "workflow.json")
  let manifest: WorkflowManifest
  try {
    manifest = parseManifest(normalizeManifestJson(JSON.parse(fs.readFileSync(manifestPath, "utf8"))))
  } catch (err) {
    throw new Error(`could not load workflow manifest ${manifestPath}: ${(err as Error).message}`)
  }
  if (manifest.kind !== kind) {
    throw new Error(`workflow manifest ${manifestPath} declares kind "${manifest.kind}" but lives in workflows/${kind}/`)
  }
  const prompts: Record<string, string> = {}
  for (const stage of manifest.stages) {
    const promptPath = path.join(dir, stage.prompt)
    try {
      prompts[stage.name] = fs.readFileSync(promptPath, "utf8")
    } catch (err) {
      throw new Error(`could not load stage prompt ${promptPath}: ${(err as Error).message}`)
    }
  }
  return { manifest, prompts }
}

/** Every workflow kind defined under `workflowsDir` (any directory holding a workflow.json). */
export const listWorkflowKinds = (workflowsDir: string): string[] => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workflowsDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(workflowsDir, e.name, "workflow.json")))
    .map((e) => e.name)
    .sort()
}
