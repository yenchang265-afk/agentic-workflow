import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { HubDeps } from "./deps.js"
import type { Repo } from "./repo.js"
import { makeRepoRegistry } from "./registry.js"

const fixture = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-registry-"))

const stubRepo = (id: string, directory: string): Repo => ({
  id,
  directory,
  deps: { directory } as HubDeps,
  reload: async () => true,
})

const noLog = (): void => {}

const enable = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".agentic-loop.json"), "{}")
}

test("rescan registers a repo that became loop-enabled after startup", async () => {
  const root = fixture()
  const added: Repo[] = []
  const registry = makeRepoRegistry({
    patterns: [path.join(root, "*")],
    cwd: root,
    initial: [],
    create: async (id, directory) => stubRepo(id, directory),
    onAdded: (repo) => added.push(repo),
    log: noLog,
  })

  await registry.rescan()
  assert.equal(registry.repos.length, 0)

  enable(path.join(root, "fresh"))
  await registry.rescan()
  assert.equal(registry.repos.length, 1)
  assert.equal(registry.byId.get("fresh")?.directory, path.join(root, "fresh"))
  assert.deepEqual(
    added.map((r) => r.id),
    ["fresh"],
  )

  // Second rescan: no duplicate registration, onAdded not re-fired.
  await registry.rescan()
  assert.equal(registry.repos.length, 1)
  assert.equal(added.length, 1)
})

test("overlapping rescans register a repo exactly once", async () => {
  const root = fixture()
  enable(path.join(root, "solo"))
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let creates = 0
  const registry = makeRepoRegistry({
    patterns: [path.join(root, "*")],
    cwd: root,
    initial: [],
    create: async (id, directory) => {
      creates++
      await gate
      return stubRepo(id, directory)
    },
    onAdded: noLog,
    log: noLog,
  })

  const first = registry.rescan()
  const second = registry.rescan() // must no-op: first still in flight
  release()
  await Promise.all([first, second])
  assert.equal(creates, 1)
  assert.equal(registry.repos.length, 1)
})

test("a failing create is warned once, retried, and does not block other repos", async () => {
  const root = fixture()
  enable(path.join(root, "bad"))
  enable(path.join(root, "good"))
  const warnings: string[] = []
  let failBad = true
  const registry = makeRepoRegistry({
    patterns: [path.join(root, "*")],
    cwd: root,
    initial: [],
    create: async (id, directory) => {
      if (id === "bad" && failBad) throw new Error("config exploded")
      return stubRepo(id, directory)
    },
    onAdded: noLog,
    log: (level, message) => {
      if (level === "warn") warnings.push(message)
    },
  })

  await registry.rescan()
  assert.deepEqual([...registry.byId.keys()], ["good"])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /config exploded/)

  // Still failing: retried but not re-warned.
  await registry.rescan()
  assert.equal(warnings.length, 1)

  failBad = false
  await registry.rescan()
  assert.deepEqual([...registry.byId.keys()].sort(), ["bad", "good"])
})

test("ids of initial repos survive a rescan that adds a colliding basename", async () => {
  const root = fixture()
  enable(path.join(root, "x", "app"))
  const initial = stubRepo("app", path.join(root, "x", "app"))
  const registry = makeRepoRegistry({
    patterns: [path.join(root, "*", "app")],
    cwd: root,
    initial: [initial],
    create: async (id, directory) => stubRepo(id, directory),
    onAdded: noLog,
    log: noLog,
  })

  enable(path.join(root, "a", "app")) // sorts before x/app
  await registry.rescan()
  assert.equal(registry.byId.get("app"), initial)
  assert.equal(registry.byId.get("app-2")?.directory, path.join(root, "a", "app"))
})
