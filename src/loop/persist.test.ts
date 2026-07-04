import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { clearState, loadState, saveState, statePath } from "./persist.ts"
import type { LoopState } from "./state.ts"

/**
 * saveState/clearState shell out via Bun `$`; loadState reads via the opencode
 * client. Both are faked over a real temp dir so the round-trip and the
 * fail-closed validation are exercised without a running opencode.
 */
const fakeShell = () => {
  const run = (strings: TemplateStringsArray, exprs: unknown[]) => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        // Reconstruct enough of the command to emulate mkdir/printf/rm.
        const raw = strings.join("\0")
        if (raw.startsWith("mkdir -p ")) {
          fs.mkdirSync(String(exprs[0]), { recursive: true })
        } else if (raw.startsWith("printf '%s' ")) {
          fs.writeFileSync(String(exprs[1]), String(exprs[0]))
        } else if (raw.startsWith("rm -f ")) {
          fs.rmSync(String(exprs[0]), { force: true })
        }
        return Promise.resolve({ exitCode: 0 }).then(resolve)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => run(strings, exprs)) as any
}

const fakeClient = (dir: string) =>
  ({
    file: {
      read: async ({ query }: { query: { path: string; directory: string } }) => {
        try {
          const content = await readFile(path.join(query.directory, query.path), "utf8")
          return { data: { content } }
        } catch {
          return { data: null }
        }
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

const sampleState: LoopState = {
  goal: "add rate limiting",
  stage: "verify",
  iteration: 1,
  paused: false,
  artifacts: { plan: "the plan", build: "built it" },
  task: { id: "add-rl", path: "/repo/docs/tasks/in-progress/add-rl.md", acceptance: ["429 over limit"] },
  git: { base: "main", branch: "loop/add-rl", worktree: "/repo/.wt/add-rl" },
}

test("statePath is under runs/ with a .state.json suffix", () => {
  assert.equal(statePath("/repo", "docs/tasks", "add-rl"), "/repo/docs/tasks/runs/add-rl.state.json")
})

test("saveState → loadState round-trips a full LoopState", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-persist-"))
  const $ = fakeShell()
  const client = fakeClient(dir)
  await saveState($, dir, "docs/tasks", "add-rl", sampleState)
  const loaded = await loadState(client, dir, "docs/tasks", "add-rl")
  assert.deepEqual(loaded, sampleState)
})

test("loadState returns null for an absent snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-persist-"))
  assert.equal(await loadState(fakeClient(dir), dir, "docs/tasks", "missing"), null)
})

test("loadState fails closed on invalid JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-persist-"))
  fs.mkdirSync(path.join(dir, "docs/tasks/runs"), { recursive: true })
  fs.writeFileSync(path.join(dir, "docs/tasks/runs/bad.state.json"), "{not json")
  assert.equal(await loadState(fakeClient(dir), dir, "docs/tasks", "bad"), null)
})

test("loadState fails closed on a schema violation (unknown stage)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-persist-"))
  fs.mkdirSync(path.join(dir, "docs/tasks/runs"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "docs/tasks/runs/bad.state.json"),
    JSON.stringify({ ...sampleState, stage: "deploy" }),
  )
  assert.equal(await loadState(fakeClient(dir), dir, "docs/tasks", "bad"), null)
})

test("clearState removes the snapshot and is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-persist-"))
  const $ = fakeShell()
  await saveState($, dir, "docs/tasks", "add-rl", sampleState)
  await clearState($, dir, "docs/tasks", "add-rl")
  assert.equal(await loadState(fakeClient(dir), dir, "docs/tasks", "add-rl"), null)
  await clearState($, dir, "docs/tasks", "add-rl") // no throw on absent
})
