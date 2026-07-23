import path from "node:path"

/**
 * The hub's one prefix-confinement rail: resolve `segments` against `root` and
 * refuse anything that escapes it (`..`, absolute paths — `path.resolve`
 * honors both). Returns the absolute path, or null. The root itself counts as
 * inside, for callers that list it. Previously spelled four slightly different
 * ways (fsclient, assets, kinds, static serving); one spelling cannot drift.
 */
export const containedIn = (root: string, ...segments: string[]): string | null => {
  const base = path.resolve(root)
  const abs = path.resolve(base, ...segments)
  return abs === base || abs.startsWith(base + path.sep) ? abs : null
}
