import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { distStaleness, staleDistWarning } from "./dist-staleness.js"

const pkg = (files: Record<string, number>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dist-"))
  for (const [rel, ageSeconds] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, "x")
    const t = new Date(Date.now() - ageSeconds * 1000)
    fs.utimesSync(abs, t, t)
  }
  return dir
}

test("distStaleness compares the newest non-test source against the newest built file", () => {
  const fresh = pkg({ "src/a.ts": 100, "src/b.test.ts": 0, "dist/a.js": 50 })
  const s = distStaleness(fresh)
  assert.equal(s?.stale, false, "a newer TEST file does not make dist stale")
  assert.equal(s?.partial, false)
  const stale = pkg({ "src/a.ts": 10, "src/deep/b.ts": 1, "dist/a.js": 50, "dist/deep/b.js": 40 })
  assert.equal(distStaleness(stale)?.stale, true)
  assert.match(staleDistWarning("core", distStaleness(stale), "Run pnpm install.") ?? "", /core: dist\/ is older than src\/ .*Run pnpm install\./)
  assert.equal(staleDistWarning("core", distStaleness(fresh), "x"), null)
})

test("distStaleness cannot tell — null — without a src or dist side, and never walks node_modules", () => {
  assert.equal(distStaleness(pkg({ "dist/a.js": 1 })), null)
  assert.equal(distStaleness(pkg({ "src/a.ts": 1 })), null)
  assert.equal(distStaleness(pkg({ "src/a.ts": 1, "dist/README.md": 0 })), null, "dist with no .js is not built")
  const withDeps = pkg({ "src/a.ts": 100, "dist/a.js": 50, "src/node_modules/x/y.ts": 0 })
  assert.equal(distStaleness(withDeps)?.stale, false)
  // A tiny budget marks the scan partial rather than hanging.
  const big = pkg(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/f${String(i)}.ts`, 100]).concat([["dist/a.js", 50]])))
  assert.equal(distStaleness(big, 5)?.partial, true)
})
