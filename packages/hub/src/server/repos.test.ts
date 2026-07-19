import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { resolveNewRepos, resolveRepos } from "./repos.js"

/** Build a directory tree under a fresh tmp root; entries ending in "/" are dirs, else files. */
const fixture = (entries: readonly string[]): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-repos-"))
  for (const entry of entries) {
    const abs = path.join(root, entry)
    if (entry.endsWith("/")) fs.mkdirSync(abs, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, "{}")
    }
  }
  return root
}

test("resolveRepos keeps explicit directories verbatim", () => {
  const root = fixture(["alpha/", "beta/docs/tasks/"])
  const { repos, notes } = resolveRepos([path.join(root, "alpha"), path.join(root, "beta")], root)
  assert.deepEqual(
    repos.map((r) => r.directory),
    [path.join(root, "alpha"), path.join(root, "beta")],
  )
  assert.deepEqual(notes, [])
})

test("resolveRepos notes and skips explicit paths that are not directories", () => {
  const root = fixture(["alpha/"])
  const { repos, notes } = resolveRepos([path.join(root, "missing")], root)
  assert.equal(repos.length, 0)
  assert.equal(notes.length, 1)
  assert.match(notes[0] as string, /missing/)
})

test("resolveRepos expands * patterns and keeps only loop repos", () => {
  const root = fixture([
    "one/.agentic-loop.json",
    "two/docs/tasks/queued/",
    "plain/", // a directory but not a loop repo
    ".hidden/docs/tasks/", // dot-dirs never match a wildcard
  ])
  const { repos, notes } = resolveRepos([path.join(root, "*")], root)
  assert.deepEqual(
    repos.map((r) => r.directory).sort(),
    [path.join(root, "one"), path.join(root, "two")],
  )
  // one note about the skipped non-loop match
  assert.equal(notes.length, 1)
  assert.match(notes[0] as string, /skipped 1/)
})

test("resolveRepos supports wildcards mid-path", () => {
  const root = fixture(["work/repo-a/docs/tasks/", "play/repo-b/docs/tasks/"])
  const { repos } = resolveRepos([path.join(root, "*", "repo-*")], root)
  assert.deepEqual(
    repos.map((r) => path.basename(r.directory)).sort(),
    ["repo-a", "repo-b"],
  )
})

test("resolveRepos dedupes directories and disambiguates colliding ids", () => {
  const root = fixture(["x/app/docs/tasks/", "y/app/docs/tasks/"])
  const dir1 = path.join(root, "x", "app")
  const dir2 = path.join(root, "y", "app")
  const { repos } = resolveRepos([dir1, dir2, dir1], root)
  assert.deepEqual(
    repos.map((r) => ({ id: r.id, directory: r.directory })),
    [
      { id: "app", directory: dir1 },
      { id: "app-2", directory: dir2 },
    ],
  )
})

test("resolveRepos sanitizes ids to url-safe slugs", () => {
  const root = fixture(["Claude Code/docs/tasks/"])
  const { repos } = resolveRepos([path.join(root, "Claude Code")], root)
  assert.equal(repos[0]?.id, "claude-code")
})

test("resolveNewRepos returns only directories absent from knownDirs", () => {
  const root = fixture(["one/.agentic-loop.json", "two/docs/tasks/"])
  const known = new Set([path.join(root, "one")])
  const fresh = resolveNewRepos([path.join(root, "*")], root, known, new Set(["one"]))
  assert.deepEqual(
    fresh.map((r) => ({ id: r.id, directory: r.directory })),
    [{ id: "two", directory: path.join(root, "two") }],
  )
})

test("resolveNewRepos keeps existing ids stable under basename collision", () => {
  // Existing repo x/app holds the id "app". A new a/app sorts first, so a
  // wholesale re-resolve would steal "app" from it — the taken-set must not.
  const root = fixture(["x/app/docs/tasks/", "a/app/docs/tasks/"])
  const known = new Set([path.join(root, "x", "app")])
  const fresh = resolveNewRepos([path.join(root, "*", "app")], root, known, new Set(["app"]))
  assert.deepEqual(
    fresh.map((r) => ({ id: r.id, directory: r.directory })),
    [{ id: "app-2", directory: path.join(root, "a", "app") }],
  )
})

test("resolveNewRepos picks up a wildcard match once it gains a loop marker", () => {
  const root = fixture(["plain/"])
  const pattern = path.join(root, "*")
  assert.deepEqual(resolveNewRepos([pattern], root, new Set(), new Set()), [])
  fs.writeFileSync(path.join(root, "plain", ".agentic-loop.json"), "{}")
  assert.deepEqual(
    resolveNewRepos([pattern], root, new Set(), new Set()).map((r) => r.directory),
    [path.join(root, "plain")],
  )
})

test("resolveNewRepos picks up an explicit path once its directory exists", () => {
  const root = fixture([])
  const dir = path.join(root, "later")
  assert.deepEqual(resolveNewRepos([dir], root, new Set(), new Set()), [])
  fs.mkdirSync(dir)
  assert.deepEqual(
    resolveNewRepos([dir], root, new Set(), new Set()).map((r) => r.directory),
    [dir],
  )
})
