import fs from "node:fs"
import path from "node:path"

/**
 * Multi-repo resolution: turn `--dir` values (or the user-scope config's
 * `hub.repos` entries — see config.ts) into the list of repos the hub
 * monitors. Values may contain `*` wildcards — `*` matches within one path
 * segment (never `/`, never a leading dot), so `--dir "~/work/*"` monitors
 * every loop repo directly under ~/work.
 *
 * Explicit paths are trusted verbatim (the user named them); wildcard matches
 * are filtered to directories that look like loop repos (.agentic-loop.json or
 * docs/tasks) so a parent full of unrelated checkouts stays quiet.
 */

export interface ResolvedRepo {
  /** URL-safe id used in `?repo=` params and the SPA picker. */
  readonly id: string
  readonly directory: string
}

export interface RepoResolution {
  readonly repos: readonly ResolvedRepo[]
  /** Human-readable skips/warnings for the startup log. */
  readonly notes: readonly string[]
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

const looksLikeLoopRepo = (dir: string): boolean =>
  isFile(path.join(dir, ".agentic-loop.json")) || isDir(path.join(dir, "docs", "tasks"))

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const segmentToRegExp = (segment: string): RegExp =>
  new RegExp(`^${segment.split("*").map(escapeRe).join(".*")}$`)

/** Expand one absolute pattern; `*` matches within a segment, dot-entries never match. */
const expandPattern = (absPattern: string): string[] => {
  const root = path.parse(absPattern).root
  const segments = absPattern.slice(root.length).split(path.sep).filter(Boolean)
  let current: string[] = [root]
  for (const segment of segments) {
    if (!segment.includes("*")) {
      current = current.map((base) => path.join(base, segment))
      continue
    }
    const re = segmentToRegExp(segment)
    const next: string[] = []
    for (const base of current) {
      let names: string[]
      try {
        names = fs.readdirSync(base)
      } catch {
        continue
      }
      for (const name of names.sort()) {
        if (name.startsWith(".")) continue
        if (re.test(name)) next.push(path.join(base, name))
      }
    }
    current = next
  }
  return current
}

const assignId = (directory: string, taken: Set<string>): string => {
  const base =
    path
      .basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** Resolve `--dir` / config patterns into monitored repos + skip notes. */
export const resolveRepos = (patterns: readonly string[], cwd: string): RepoResolution => {
  const dirs: string[] = []
  const notes: string[] = []
  for (const pattern of patterns) {
    const abs = path.resolve(cwd, pattern)
    if (!pattern.includes("*")) {
      if (isDir(abs)) dirs.push(abs)
      else notes.push(`${pattern}: not a directory — skipped`)
      continue
    }
    const matched = expandPattern(abs).filter(isDir)
    const repos = matched.filter(looksLikeLoopRepo)
    if (repos.length === 0) notes.push(`${pattern}: no loop repos matched`)
    else if (matched.length > repos.length) {
      const n = matched.length - repos.length
      notes.push(`${pattern}: skipped ${n} non-loop ${n === 1 ? "match" : "matches"}`)
    }
    dirs.push(...repos)
  }
  const taken = new Set<string>()
  const repos = [...new Set(dirs)].map((directory) => ({ id: assignId(directory, taken), directory }))
  return { repos, notes }
}
