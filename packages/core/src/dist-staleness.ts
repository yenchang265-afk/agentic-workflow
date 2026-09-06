import fs from "node:fs"
import path from "node:path"

/**
 * Is a package's built `dist/` older than its `src/` (design 62)?
 *
 * The bundled hooks and the OpenCode plugin both resolve core through
 * `packages/core/dist`, which is gitignored and rebuilt only by `pnpm install`
 * — so a `git pull` that changes core leaves every consumer running the OLD
 * core with nothing failing. The known symptom was a gate result with no
 * `data.gate` on it ("armTaskGateAsk returning ''"), diagnosed after the fact
 * on one host; this is the session-start check that names the cause first.
 *
 * Synchronous `node:fs` only: it runs inside a bundled hook with no
 * dependencies, and it is BUDGETED — the walk stops at `maxFiles` and reports
 * `partial`, because a hook that walks an unbounded tree is a hook the host
 * kills at its deadline, taking the whole session-start report with it.
 * Absent `src/` or `dist/` reads as "cannot tell" (null), never as stale: a
 * plugin installed away from the monorepo has no sources to compare.
 */
export interface DistStaleness {
  readonly stale: boolean
  readonly srcNewest: number
  readonly distNewest: number
  readonly partial: boolean
}

const SRC_EXT = /\.(ts|tsx|mts|cts)$/
const TEST_FILE = /\.test\.(ts|tsx|mts|cts)$/

/** Newest mtime (ms) under `dir` for files matching `accept`, walking at most `budget.left` entries. */
const newestMtime = (dir: string, accept: (name: string) => boolean, budget: { left: number }): number | null => {
  let newest: number | null = null
  const stack = [dir]
  while (stack.length && budget.left > 0) {
    const cur = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (budget.left-- <= 0) break
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name !== "node_modules") stack.push(p)
        continue
      }
      if (!e.isFile() || !accept(e.name)) continue
      try {
        const m = fs.statSync(p).mtimeMs
        if (newest === null || m > newest) newest = m
      } catch {
        /* a vanished file is not evidence either way */
      }
    }
  }
  return newest
}

/**
 * Compare `<pkgDir>/src` (TypeScript sources, tests excluded) with
 * `<pkgDir>/dist` (built JS). Null when either side is missing or empty.
 */
export const distStaleness = (pkgDir: string, maxFiles = 4000): DistStaleness | null => {
  const src = path.join(pkgDir, "src")
  const dist = path.join(pkgDir, "dist")
  if (!fs.existsSync(src) || !fs.existsSync(dist)) return null
  // One budget PER side: a shared one let a large src tree starve the dist
  // walk to nothing, which read as "cannot tell" instead of "partial".
  const srcBudget = { left: maxFiles }
  const distBudget = { left: maxFiles }
  const srcNewest = newestMtime(src, (n) => SRC_EXT.test(n) && !TEST_FILE.test(n), srcBudget)
  const distNewest = newestMtime(dist, (n) => n.endsWith(".js"), distBudget)
  if (srcNewest === null || distNewest === null) return null
  return { stale: srcNewest > distNewest, srcNewest, distNewest, partial: srcBudget.left <= 0 || distBudget.left <= 0 }
}

/** The one-line warning both hosts print for a stale package, or null. Pure. */
export const staleDistWarning = (label: string, s: DistStaleness | null, rebuild: string): string | null =>
  s?.stale
    ? `${label}: dist/ is older than src/ (built ${new Date(s.distNewest).toISOString()}, sources changed ${new Date(s.srcNewest).toISOString()}) — you are running stale code. ${rebuild}${s.partial ? " (partial scan)" : ""}`
    : null
