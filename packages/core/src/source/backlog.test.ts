import { defaultLoopsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { Client, Shell } from "../host.js"
import { registerEngineeringHooks } from "../kinds/engineering.js"
import { loadManifest } from "../manifest/load.js"
import { PLAN_HEADING } from "../task/store.js"
import { claimSkipReason, makeBacklogSource, taskGoal } from "./backlog.js"

/**
 * The backlog source over the real engineering manifest, against an in-memory
 * backlog (fake client) and a stateful claim-marker shell (mirrors
 * store.test.ts's fakes). Claim-walk mechanics themselves are covered by the
 * store suite; this covers the source's pool ordering, entry states, skip
 * reasons, and release semantics.
 */

registerEngineeringHooks()

const LOOPS_DIR = defaultLoopsDir()
const eng = loadManifest(LOOPS_DIR, "engineering")

type FakeFile = { readonly name: string; readonly content: string }

const fakeClient = (folders: Record<string, FakeFile[]>): Client => ({
  file: {
    async list({ query }) {
      const status = query.path.split("/").pop() ?? ""
      const files = folders[status] ?? []
      return {
        data: files.map((f) => ({
          type: "file" as const,
          name: f.name,
          path: `${query.path}/${f.name}`,
          absolute: `/r/${query.path}/${f.name}`,
        })),
      }
    },
    async read({ query }) {
      const status = query.path.split("/").slice(-2, -1)[0] ?? ""
      const name = query.path.split("/").pop() ?? ""
      const f = (folders[status] ?? []).find((x) => x.name === name)
      return { data: f ? { content: f.content } : null }
    },
  },
  app: { async log() {} },
})

/** Marker-aware shell: mkdir fails on held ids; rmdir releases. */
const fakeShell = (held: Set<string>): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    const id = cmd.split("/").pop() ?? ""
    const run = (): { exitCode: number; stdout: string } => {
      if (cmd.startsWith("mkdir -p")) return { exitCode: 0, stdout: "" }
      if (cmd.startsWith("mkdir ")) return { exitCode: held.has(id) ? 1 : 0, stdout: "" }
      if (cmd.startsWith("rmdir ")) {
        held.delete(id)
        return { exitCode: 0, stdout: "" }
      }
      return { exitCode: 0, stdout: "" }
    }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = run()
        return Promise.resolve({
          exitCode: r.exitCode,
          stdout: { toString: () => r.stdout },
          stderr: { toString: () => "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const file = (id: string, opts: { plan?: boolean; started?: boolean } = {}): FakeFile => {
  const plan = opts.plan ? `\n${PLAN_HEADING}\n\n1. Do the thing.\n` : ""
  const started = opts.started ? `\n> BUILD started (iteration 1) — 2026-01-01T00:00:00.000Z\n` : ""
  return {
    name: `${id}.md`,
    content: `---\ntitle: ${id}\npriority: 2\n---\n\nBody of ${id}.\n${plan}${started}`,
  }
}

const source = (folders: Record<string, FakeFile[]>, held = new Set<string>()) =>
  makeBacklogSource({
    $: fakeShell(held),
    client: fakeClient(folders),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: eng,
    isDriving: () => false,
  })

test("claims build-ready in-progress work before queued plan work", async () => {
  const src = source({
    "in-progress": [file("build-me", { plan: true })],
    queued: [file("plan-me")],
  })
  const { item, skip } = await src.claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "build-me")
  assert.equal(item?.entryStage, "build")
  assert.equal(item?.state.kind, "engineering")
  assert.equal(item?.state.stage, "build")
  assert.match(item?.state.artifacts.plan ?? "", /Do the thing/)
  assert.match(item?.claimMessage ?? "", /building…/)
})

test("falls back to the queued pool when in-progress has nothing claimable", async () => {
  const src = source({
    "in-progress": [file("already-started", { plan: true, started: true })],
    queued: [file("plan-me")],
  })
  const { item } = await src.claimNext()
  assert.equal(item?.id, "plan-me")
  assert.equal(item?.entryStage, "plan")
  assert.deepEqual(item?.state.artifacts, {})
  assert.match(item?.claimMessage ?? "", /planning…/)
})

test("an empty backlog yields the both-empty skip reason", async () => {
  const { item, skip } = await source({ "in-progress": [], queued: [] }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /queued\/ and in-progress\/ are both empty/)
  assert.equal(skip?.actionable, false)
})

test("a held marker on the only claimable task is reported actionably", async () => {
  const src = source({ "in-progress": [file("busy", { plan: true })], queued: [] }, new Set(["busy"]))
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for busy/)
  assert.equal(skip?.actionable, true)
})

test("started-but-unclaimed tasks point at recover", async () => {
  const src = source({ "in-progress": [file("crashed", { plan: true, started: true })], queued: [] })
  const { skip } = await src.claimNext()
  assert.match(skip?.message ?? "", /already started: crashed .*recover/)
})

test("release frees a still-claimable build claim but keeps a started one", async () => {
  const folders = { "in-progress": [file("t", { plan: true })], queued: [] }
  const held = new Set<string>()
  const src = source(folders, held)
  const { item } = await src.claimNext()
  assert.ok(item)
  // Body untouched (still claimable) → release drops the marker.
  await src.release(item)
  // Now simulate a run that got to BUILD started — release must be a no-op.
  folders["in-progress"] = [file("t", { plan: true, started: true })]
  const again = await source(folders, new Set(["t"])).claimNext()
  assert.equal(again.item, null) // held + no longer claimable
})

test("taskGoal joins title and body", () => {
  assert.equal(taskGoal({ id: "x", title: "T", priority: 1, acceptance: [], body: "B", path: "/p" }), "T\n\nB")
})

test("claimSkipReason precedence: held beats empty beats started", () => {
  assert.match(claimSkipReason(0, 0, 0, [], ["h"]).message, /held/)
  assert.match(claimSkipReason(0, 0, 0, [], []).message, /both empty/)
  assert.match(claimSkipReason(2, 0, 0, ["a"], []).message, /already started/)
  assert.match(claimSkipReason(2, 0, 0, [], []).message, /no persisted plan/)
})
