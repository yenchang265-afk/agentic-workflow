import { z } from "zod"
import { ConfigSchema, droppedRepoKeys, mergeConfigLayers, sanitizeRepoLayer } from "@agentic-workflow/core/config"
import { REDACTED, type ConfigEdit, type ConfigIssue, type ConfigLayer, type ConfigLayerResponse, type ConfigProvenance, type SaveConfigRequest, type SaveConfigResponse } from "../../shared/api.js"
import { isGitIgnored, knownTopLevelKeys, layerPath, readRawLayer, redactSecrets, SECRET_PATHS, writeRawLayer } from "../configfile.js"
import { deleteAt, isPlainObject, isSafeConfigPath, leafPaths, provenanceOf, setAt, valueAt } from "../configlayers.js"
import type { HubDeps } from "../deps.js"
import { badRequest, json, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { withLock } from "../lock.js"
import { lintWorkflowKnobs } from "../knobs.js"

/**
 * Read and write `.agentic-workflow.json` — the file that grants every other
 * authority, which is why this route is the most carefully fenced one here.
 *
 * Two rules carry it, and neither is optional:
 *
 * 1. **Raw is the model; zod is only a linter.** `ConfigSchema` is a plain
 *    `z.object`, so parsing strips keys it doesn't know. A parse-then-write
 *    would silently delete the `hub` section — the hub deleting its own config —
 *    along with any host-only or retired key the file still carries. Edits are
 *    applied to raw JSON; the schema only ever *refuses* a write.
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

  const repo = await readRawLayer(deps, "repo")
  const user = await readRawLayer(deps, "user")
  const self = layer === "repo" ? repo : user

  // The runtime drops user-layer-only keys from the repo layer BEFORE merging
  // (`loadConfigWith`), so the effective/provenance views must merge the same
  // sanitized layer — this route used to merge RAW, showing a repo-layer
  // `stageChecks`/`worktreeSetup`/`ado.organization` as "in effect" when the
  // loop ignores it. The per-layer `raw` view stays unsanitized on purpose:
  // it shows the FILE, and `droppedRepoKeys` is what says which of its keys
  // the runtime discards.
  const dropped = droppedRepoKeys(repo.raw ?? {}).map((d) => d.path)
  const repoSanitized = sanitizeRepoLayer(repo.raw ?? {})
  const merged = mergeConfigLayers(user.raw ?? {}, repoSanitized)
  const parsed = ConfigSchema.safeParse(merged)
  const { raw: redacted, redactedPaths } = self.raw ? redactSecrets(self.raw) : { raw: null, redactedPaths: [] }

  const response: ConfigLayerResponse = {
    layer,
    path: self.path,
    raw: redacted,
    // Display only. Never written back — see the header comment.
    effective: parsed.success ? (redactSecrets(parsed.data as unknown as Record<string, unknown>).raw as Record<string, unknown>) : null,
    provenance: provenanceMap(user.raw, repoSanitized),
    droppedRepoKeys: dropped,
    issues: issuesOf(merged),
    warnings: lintWorkflowKnobs(valueAt(merged, ["workflows"]), deps.boards),
    passthrough: passthroughOf(self.raw),
    redactedPaths,
    ...(self.parseError ? { parseError: self.parseError } : {}),
  }
  return ok(response)
}

const applyEdits = (raw: Record<string, unknown>, edits: readonly ConfigEdit[]): unknown => {
  let next: unknown = raw
  for (const edit of edits) {
    const path = edit.path.split(".").filter(Boolean)
    if (path.length === 0) continue
    if (edit.value === undefined) {
      next = deleteAt(next, path)
      continue
    }
    // The sentinel means "unchanged": the browser never received the real
    // secret, so echoing it back must not overwrite it with the placeholder —
    // and when no secret is stored, the sentinel must not be persisted as one.
    const isSentinelSecret = edit.value === REDACTED && SECRET_PATHS.some((p) => p.join(".") === edit.path)
    next = isSentinelSecret ? next : setAt(next, path, edit.value)
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
  // The edits array is the one client-supplied structure this route consumes, so
  // it is validated like every other request body (contrast tasks.ts's
  // SaveTaskRequestSchema). The old shape-check optional-chained `edit?.path`,
  // which let `[{}]` through to `applyEdits`'s `edit.path.split(".")` — a
  // TypeError that surfaced as a 500 with a raw JS message. `value` stays
  // `unknown` and optional: absent means "delete this path".
  const parsedEdits = z.array(z.object({ path: z.string(), value: z.unknown().optional() })).safeParse(body?.edits)
  if (!parsedEdits.success) return badRequest("body.edits must be an array of { path, value? }")

  const file = layerPath(deps, layer as ConfigLayer)
  if (!file) return badRequest("the user-scope config layer is disabled (AGENTIC_WORKFLOW_USER_CONFIG is empty)")

  for (const edit of parsedEdits.data as ConfigEdit[]) {
    const segments = edit.path.split(".").filter(Boolean)
    if (segments.length > 0 && !isSafeConfigPath(segments)) {
      return badRequest(`refusing edit path "${edit.path}": prototype-shaped or empty key segments are not writable`)
    }
  }

  // Read-modify-write of one file: without the lock, two concurrent saves both
  // read the same "current", and the second write silently drops the first's
  // edits. Same TOCTOU shape the gate route closes, same fix.
  return withLock(`config:${file}`, async () => {
    const self = await readRawLayer(deps, layer as ConfigLayer)
    if (self.parseError) return json(400, { error: `refusing to edit ${file}: ${self.parseError} — fix the file by hand first` })

    const current = self.raw ?? {}
    const next = applyEdits(current, parsedEdits.data as ConfigEdit[])
    if (!isPlainObject(next)) return badRequest("edits must leave a JSON object at the top level")

    // Validate the MERGED view, not this layer alone: a repo layer is routinely
    // invalid on its own (codePlatform "ado" with the ado section in the user
    // layer) and refusing that would be wrong.
    const other = await readRawLayer(deps, layer === "repo" ? "user" : "repo")
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

    await writeRawLayer(file, next)
    // Config is read once at startup, so without this the board would keep
    // serving the old config until a restart.
    await deps.reloadRepo?.()

    const response: SaveConfigResponse = {
      written: file,
      warnings: lintWorkflowKnobs(valueAt(merged, ["workflows"]), deps.boards),
    }
    return ok(response)
  })
}
