import fs from "node:fs"
import path from "node:path"
import { ConfigSchema, resolveUserConfigPath } from "@agentic-loop/core/config"
import type { Shell } from "@agentic-loop/core/host"
import { REDACTED, type ConfigLayer } from "../shared/api.js"
import { isPlainObject, valueAt } from "./configlayers.js"
import type { HubDeps } from "./deps.js"

/**
 * Raw read/write of the two `.agentic-loop.json` layers.
 *
 * **Raw is the model; zod is only a linter.** `ConfigSchema` is a plain
 * `z.object`, so zod v4 *strips* keys it doesn't know. Parsing a config and
 * writing the result back would silently delete `watchIntervalMinutes` (host-only,
 * added by the OpenCode plugin via `safeExtend`) and the entire `hub` section —
 * which is how the hub found this repo in the first place. So nothing here ever
 * writes a parsed object: edits are applied to the raw JSON, and the schema is
 * used to *refuse* a bad write, never to produce the bytes.
 */

/** Secrets, by exact path. Not a regex: a pattern would also eat prose, and these are known. */
export const SECRET_PATHS: readonly (readonly string[])[] = [["ado", "pat"]]

/** Top-level keys core's schema knows. Everything else in a file is passthrough. */
export const knownTopLevelKeys = (): readonly string[] => Object.keys(ConfigSchema.shape)

export interface RawLayer {
  /** Absolute path, or null when the layer is disabled (AGENTIC_LOOP_USER_CONFIG="" / no home). */
  readonly path: string | null
  /** The file's JSON, or null when absent/unreadable/unparseable. */
  readonly raw: Record<string, unknown> | null
  /** Set when the file exists but isn't valid JSON — surfaced to the editor, never thrown. */
  readonly parseError?: string
}

export const layerPath = (deps: HubDeps, layer: ConfigLayer): string | null =>
  layer === "repo" ? path.join(deps.directory, ".agentic-loop.json") : resolveUserConfigPath()

/**
 * Read one layer's raw JSON. A malformed file is reported, not thrown: the whole
 * point of the editor is to fix exactly that, so it has to be able to render it.
 */
export const readRawLayer = (deps: HubDeps, layer: ConfigLayer): RawLayer => {
  const file = layerPath(deps, layer)
  if (!file) return { path: null, raw: null }
  let content: string
  try {
    content = fs.readFileSync(file, "utf8")
  } catch {
    return { path: file, raw: null }
  }
  if (!content.trim()) return { path: file, raw: null }
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    return { path: file, raw: null, parseError: `not valid JSON (${(err as Error).message})` }
  }
  if (!isPlainObject(json)) return { path: file, raw: null, parseError: "top level must be a JSON object" }
  return { path: file, raw: json }
}

/**
 * Replace secret values with a sentinel on the way out, so `ado.pat` never
 * reaches the browser. The path is reported alongside so a save can tell
 * "unchanged" (the sentinel came back) from "cleared".
 */
export const redactSecrets = (raw: Record<string, unknown>): { raw: Record<string, unknown>; redactedPaths: string[] } => {
  let out = raw
  const redactedPaths: string[] = []
  for (const p of SECRET_PATHS) {
    if (typeof valueAt(raw, p) !== "string") continue
    out = setSecret(out, p, REDACTED)
    redactedPaths.push(p.join("."))
  }
  return { raw: out, redactedPaths }
}

const setSecret = (root: Record<string, unknown>, p: readonly string[], value: string): Record<string, unknown> => {
  const [key, ...rest] = p
  const k = key as string
  if (rest.length === 0) return { ...root, [k]: value }
  const child = root[k]
  return { ...root, [k]: setSecret(isPlainObject(child) ? child : {}, rest, value) }
}

/**
 * Whether `file` is ignored by git in `directory`. Used to refuse writing a
 * plaintext PAT into a file that would be committed — the warning at
 * `config.ts`'s `ado.pat` is a comment nobody reads; this makes it a rail, at
 * the one moment it matters.
 */
export const isGitIgnored = async ($: Shell, directory: string, file: string): Promise<boolean> => {
  const out = await $`git -C ${directory} check-ignore -q ${file}`.quiet().nothrow()
  return out.exitCode === 0
}

/**
 * Write raw JSON back, pretty-printed with a trailing newline (how the repo's
 * own config is formatted). Temp + rename so a loop process running
 * `loadConfig` concurrently never reads a torn file.
 */
export const writeRawLayer = (file: string, raw: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
  fs.renameSync(tmp, file)
}
