import type { ConfigProvenance } from "../shared/api.js"

/**
 * Which layer a config value actually comes from.
 *
 * `.agentic-workflow.json` is two files: the user-scope `~/.agentic-workflow.json` and
 * the repo's own, merged by core's `mergeConfigLayers` with the repo winning
 * field by field. An editor that showed only the merged view could not tell you
 * *where* a value lives — and worse, could not save it back to the right file.
 *
 * This mirrors core's merge rule rather than re-deriving it. That is a real
 * duplication risk, so `configlayers.test.ts` pins it with a property test
 * against `mergeConfigLayers` itself: drift becomes a red test, not a wrong
 * badge in the UI.
 *
 * The rule being mirrored (config.ts `mergeConfigLayers`): **only plain objects
 * recurse.** Arrays, scalars and `null` replace wholesale — a repo
 * `reviewLenses: []` masks the user's list entirely rather than merging into it.
 */

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Read the value at a key path, descending plain objects only. `undefined` when absent. */
export const valueAt = (root: unknown, path: readonly string[]): unknown => {
  let cur: unknown = root
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/**
 * Which layer supplies the merged value at `path`.
 *
 * `"default"` means neither layer sets it — the value the loop actually uses
 * comes from the schema's defaults, not from any file. (Note this reflects the
 * *raw* layers, before zod applies defaults.)
 */
export const provenanceOf = (userRaw: unknown, repoRaw: unknown, path: readonly string[]): ConfigProvenance => {
  if (path.length === 0) {
    if (repoRaw !== undefined) return "repo"
    if (userRaw !== undefined) return "user"
    return "default"
  }
  const [key, ...rest] = path
  const u = isPlainObject(userRaw) ? userRaw[key as string] : undefined
  const r = isPlainObject(repoRaw) ? repoRaw[key as string] : undefined

  // The merge recurses only when BOTH sides are plain objects. Otherwise the
  // override replaces wholesale, and everything beneath it belongs to whichever
  // layer won — so we keep descending with the loser dropped.
  if (isPlainObject(u) && isPlainObject(r)) return provenanceOf(u, r, rest)
  if (r !== undefined) return provenanceOf(undefined, r, rest)
  return provenanceOf(u, undefined, rest)
}

/** Every leaf key path in a raw config object (a leaf being any non-plain-object). */
export const leafPaths = (root: unknown, prefix: readonly string[] = []): string[][] => {
  if (!isPlainObject(root)) return prefix.length ? [[...prefix]] : []
  const out: string[][] = []
  for (const [key, value] of Object.entries(root)) {
    if (isPlainObject(value) && Object.keys(value).length > 0) out.push(...leafPaths(value, [...prefix, key]))
    else out.push([...prefix, key])
  }
  return out
}

/**
 * Immutably set a key path, creating intermediate objects. Returns a new root —
 * the raw config is never mutated in place, so a failed validation leaves the
 * caller's copy intact.
 */
export const setAt = (root: unknown, path: readonly string[], value: unknown): unknown => {
  if (path.length === 0) return value
  const [key, ...rest] = path
  const base = isPlainObject(root) ? root : {}
  return { ...base, [key as string]: setAt(base[key as string], rest, value) }
}

/** Immutably delete a key path. Prunes nothing else — an emptied parent object stays. */
export const deleteAt = (root: unknown, path: readonly string[]): unknown => {
  if (path.length === 0 || !isPlainObject(root)) return root
  const [key, ...rest] = path
  if (!Object.hasOwn(root, key as string)) return root
  if (rest.length === 0) {
    const { [key as string]: _drop, ...keep } = root
    return keep
  }
  return { ...root, [key as string]: deleteAt(root[key as string], rest) }
}
