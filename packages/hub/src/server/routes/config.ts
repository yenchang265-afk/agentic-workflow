import { ConfigSchema, mergeConfigLayers } from "@agentic-workflow/core/config"
import { REDACTED, type ConfigEdit, type ConfigIssue, type ConfigLayer, type ConfigLayerResponse, type ConfigProvenance, type SaveConfigRequest, type SaveConfigResponse } from "../../shared/api.js"
import { isGitIgnored, knownTopLevelKeys, layerPath, readRawLayer, redactSecrets, SECRET_PATHS, writeRawLayer } from "../configfile.js"
import { deleteAt, isPlainObject, leafPaths, provenanceOf, setAt, valueAt } from "../configlayers.js"
import type { HubDeps } from "../deps.js"
import { badRequest, json, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { lintWorkflowKnobs } from "../knobs.js"

/**
 * Read and write `.agentic-workflow.json` — the file that grants every other
 * authority, which is why this route is the most carefully fenced one here.
 *
 * Two rules carry it, and neither is optional:
 *
 * 1. **Raw is the model; zod is only a linter.** `ConfigSchema` is a plain
 *    `z.object`, so parsing strips keys it doesn't know. A parse-then-write
 *    would silently delete `watchIntervalMinutes` and the `hub` section — the
 *    hub deleting its own config. Edits are applied to raw JSON; the schema only
 *    ever *refuses* a write.
 * 2. **One named layer at a time.** `mergeConfigLayers` merges the user layer
 *    under the repo's, so saving the *merged* view to the repo file would
 *    flatten the user layer into it — writing `ado.pat` out of
 *    `~/.agentic-workflow.json` and into a repo file. `effective` is display-only,
 *    forever.
 */

const isLayer = (s: string | null): s is ConfigLayer => s === "repo" || s === "user"

const issuesOf = (merged: unknown): ConfigIssue[] => {
  const result = ConfigSchema.safeParse(merged)
  if (result.success) return []
  return result.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }))
}

/** Keys on disk that core's schema doesn't know — preserved, and shown as preserved. */
const passthroughOf = (raw: Record<string, unknown> | null): string[] => {
  if (!raw) return []
  const known = new Set(knownTopLevelKeys())
  return Object.keys(raw).filter((k) => !known.has(k))
}

const provenanceMap = (userRaw: unknown, repoRaw: unknown): Record<string, ConfigProvenance> => {
  const merged = mergeConfigLayers(userRaw ?? {}, repoRaw ?? {})
  const out: Record<string, ConfigProvenance> = {}
  for (const p of leafPaths(merged)) out[p.join(".")] = provenanceOf(userRaw, repoRaw, p)
  return out
}

/** GET /api/config?layer=repo|user — that layer's raw JSON plus the merged view it contributes to. */
export const getConfig = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const layer = req.query.get("layer") ?? "repo"
  if (!isLayer(layer)) return badRequest(`layer must be "repo" or "user"`)

  const repo = readRawLayer(deps, "repo")
  const user = readRawLayer(deps, "user")
  const self = layer === "repo" ? repo : user

  const merged = mergeConfigLayers(user.raw ?? {}, repo.raw ?? {})
  const parsed = ConfigSchema.safeParse(merged)
  const { raw: redacted, redactedPaths } = self.raw ? redactSecrets(self.raw) : { raw: null, redactedPaths: [] }

  const response: ConfigLayerResponse = {
    layer,
    path: self.path,
    raw: redacted,
    // Display only. Never written back — see the header comment.
    effective: parsed.success ? (redactSecrets(parsed.data as unknown as Record<string, unknown>).raw as Record<string, unknown>) : null,
    provenance: provenanceMap(user.raw, repo.raw),
    issues: issuesOf(merged),
    warnings: lintWorkflowKnobs(valueAt(merged, ["workflows"]), deps.boards),
    passthrough: passthroughOf(self.raw),
    redactedPaths,
    ...(self.parseError ? { parseError: self.parseError } : {}),
  }
  return ok(response)
}

const applyEdits = (raw: Record<string, unknown>, edits: readonly ConfigEdit[], previous: Record<string, unknown>): unknown => {
  let next: unknown = raw
  for (const edit of edits) {
    const path = edit.path.split(".").filter(Boolean)
    if (path.length === 0) continue
    if (edit.value === undefined) {
      next = deleteAt(next, path)
      continue
    }
    // The sentinel means "unchanged": the browser never received the real
    // secret, so echoing it back must not overwrite it with the placeholder.
    const isUntouchedSecret =
      edit.value === REDACTED && SECRET_PATHS.some((p) => p.join(".") === edit.path) && typeof valueAt(previous, path) === "string"
    next = isUntouchedSecret ? next : setAt(next, path, edit.value)
  }
  return next
}

/**
 * POST /api/config — body `{ layer, edits }`. Applies edits to the named layer's
 * raw JSON and writes it back.
 *
 * Re-reads from disk rather than trusting a client echo: the browser was handed
 * a redacted copy, so it is not a source of truth for this file's contents.
 */
export const saveConfig = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as Partial<SaveConfigRequest> | undefined
  const layer = body?.layer
  if (!isLayer(layer ?? null)) return badRequest(`body must be { layer: "repo" | "user", edits: [...] }`)
  if (!Array.isArray(body?.edits)) return badRequest("body.edits must be an array of { path, value? }")

  const file = layerPath(deps, layer as ConfigLayer)
  if (!file) return badRequest("the user-scope config layer is disabled (AGENTIC_WORKFLOW_USER_CONFIG is empty)")

  const self = readRawLayer(deps, layer as ConfigLayer)
  if (self.parseError) return json(400, { error: `refusing to edit ${file}: ${self.parseError} — fix the file by hand first` })

  const current = self.raw ?? {}
  const next = applyEdits(current, body.edits, current)
  if (!isPlainObject(next)) return badRequest("edits must leave a JSON object at the top level")

  // Validate the MERGED view, not this layer alone: a repo layer is routinely
  // invalid on its own (codePlatform "ado" with the ado section in the user
  // layer) and refusing that would be wrong.
  const other = readRawLayer(deps, layer === "repo" ? "user" : "repo")
  const merged =
    layer === "repo" ? mergeConfigLayers(other.raw ?? {}, next) : mergeConfigLayers(next, other.raw ?? {})
  const issues = issuesOf(merged)
  if (issues.length > 0) return json(400, { error: "config invalid — not written", issues })

  /*
   * A plaintext PAT in a committed file is a leaked credential. core's schema
   * warns about it in a comment nobody reads; make it a rail at the one moment
   * it matters — when a write would newly introduce one into the repo layer.
   */
  if (layer === "repo" && typeof valueAt(next, ["ado", "pat"]) === "string" && typeof valueAt(current, ["ado", "pat"]) !== "string") {
    if (!(await isGitIgnored(deps.sh, deps.directory, file))) {
      return json(400, {
        error: `refusing to write ado.pat into ${file}: it is not gitignored, so the secret would be committed. Put the PAT in the AZURE_DEVOPS_EXT_PAT env var, or gitignore the file first.`,
      })
    }
  }

  writeRawLayer(file, next)
  // Config is read once at startup, so without this the board would keep
  // serving the old config until a restart.
  await deps.reloadRepo?.()

  const response: SaveConfigResponse = {
    written: file,
    warnings: lintWorkflowKnobs(valueAt(merged, ["workflows"]), deps.boards),
  }
  return ok(response)
}
