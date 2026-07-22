import { defaultWorkflowsDir } from "../manifest/dir.js"
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

const WORKFLOWS_DIR = defaultWorkflowsDir()
const eng = loadManifest(WORKFLOWS_DIR, "engineering")

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

/**
 * Marker-aware shell: mkdir fails on held ids; rmdir releases. `cat` answers
 * from `realFs` — the REAL filesystem the claim reverification reads, as
 * opposed to the (possibly lagging) client index `fakeClient` serves.
 */
const fakeShell = (held: Set<string>, realFs: Record<string, FakeFile[]> = {}, log?: string[]): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log?.push(cmd)
    const id = cmd.split("/").pop() ?? ""
    const run = (): { exitCode: number; stdout: string } => {
      if (cmd.startsWith("mkdir -p")) return { exitCode: 0, stdout: "" }
      if (cmd.startsWith("mkdir ")) return { exitCode: held.has(id) ? 1 : 0, stdout: "" }
      if (cmd.startsWith("rmdir ")) {
        held.delete(id)
        return { exitCode: 0, stdout: "" }
      }
      if (cmd.startsWith("cat ")) {
        // cat /r/docs/tasks/<status>/<id>.md
        const parts = cmd.split(" ")[1]?.split("/") ?? []
        const name = parts.pop() ?? ""
        const status = parts.pop() ?? ""
        const f = (realFs[status] ?? []).find((x) => x.name === name)
        return f ? { exitCode: 0, stdout: f.content } : { exitCode: 1, stdout: "" }
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

const file = (id: string, opts: { plan?: boolean; started?: boolean; claimed?: boolean } = {}): FakeFile => {
  const plan = opts.plan ? `\n${PLAN_HEADING}\n\n1. Do the thing.\n` : ""
  const claimed = opts.claimed ? `\n> CLAIMED — loop starting [2026-01-01T00:00:00.000Z]\n` : ""
  const started = opts.started ? `\n> BUILD started (iteration 1) — 2026-01-01T00:00:00.000Z\n` : ""
  return {
    name: `${id}.md`,
    content: `---\ntitle: ${id}\npriority: 2\n---\n\nBody of ${id}.\n${plan}${claimed}${started}`,
  }
}

const source = (
  folders: Record<string, FakeFile[]>,
  held = new Set<string>(),
  opts: { realFs?: Record<string, FakeFile[]>; shellLog?: string[] } = {},
) =>
  makeBacklogSource({
    // The client index and the real FS agree by default; pass `realFs` to
    // model an index that lags the real filesystem.
    $: fakeShell(held, opts.realFs ?? folders, opts.shellLog),
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

test("never claims from the queued pool even when in-progress has nothing claimable", async () => {
  const src = source({
    "in-progress": [file("already-started", { plan: true, started: true })],
    queued: [file("plan-me")],
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /already started: already-started .*recover/)
})

test("queued-only backlog claims nothing and points at plan <id>", async () => {
  const held = new Set<string>()
  const src = source({ "in-progress": [], queued: [file("plan-me")] }, held)
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /awaiting a plan in queued\/ .*plan <id>/)
  assert.equal(skip?.actionable, true)
  assert.equal(held.size, 0)
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

test("release frees a claim whose body already carries the CLAIMED note", async () => {
  // The driver appends "> CLAIMED" BEFORE establishing isolation, then releases
  // if isolation throws. Gating that release on `isClaimable` (which the CLAIMED
  // note itself falsifies) made every such release a silent no-op, wedging the
  // marker forever: the 15m orphan sweep and `doctor fix` key off the same
  // predicate, so neither could free it either. Only durable work — a
  // "> BUILD started" note — may keep the marker for recovery.
  const folders = { "in-progress": [file("t", { plan: true })], queued: [] }
  const shellLog: string[] = []
  const src = source(folders, new Set<string>(), { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  // markClaimedOnHumanBranch ran; then ensureIsolation threw.
  folders["in-progress"] = [file("t", { plan: true, claimed: true })]
  shellLog.length = 0
  await src.release(item)
  assert.ok(
    shellLog.some((c) => c.startsWith("rmdir") && c.includes("/t")),
    `marker not released so watch can never re-claim: ${shellLog.join(" | ")}`,
  )
})

test("release keeps a claim whose body reached BUILD started, even with a CLAIMED note", async () => {
  const folders = { "in-progress": [file("t", { plan: true })], queued: [] }
  const shellLog: string[] = []
  const src = source(folders, new Set<string>(), { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  folders["in-progress"] = [file("t", { plan: true, claimed: true, started: true })]
  shellLog.length = 0
  await src.release(item)
  assert.ok(
    !shellLog.some((c) => c.startsWith("rmdir")),
    "durable work must keep the marker for recover <id>",
  )
})

test("a CLAIMED note (durable claim evidence on the human branch) blocks re-claiming and points at recover", async () => {
  // The theater-booking-0 bug: isolation committed every BUILD note onto
  // feature/<id>, the human branch's task file looked untouched, and the
  // watcher re-claimed a task whose run already finished. The CLAIMED note —
  // committed before the branch is cut — is what must defeat the re-claim.
  const src = source({ "in-progress": [file("ran-already", { plan: true, claimed: true })], queued: [] })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /already started: ran-already/)
})

test("a stale listing of a task already moved off the real FS is not claimed, and its marker is released", async () => {
  // A finished run mv'd the task to in-review/ and released its marker, but
  // the client index still lists it in in-progress/ with a claimable body.
  const shellLog: string[] = []
  const src = source({ "in-progress": [file("done-already", { plan: true })], queued: [] }, new Set(), {
    realFs: { "in-progress": [], "in-review": [file("done-already", { plan: true, claimed: true })] },
    shellLog,
  })
  const { item } = await src.claimNext()
  assert.equal(item, null)
  assert.ok(shellLog.some((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/done-already")))
})

test("a stale listing whose real-FS body already carries the CLAIMED note is not claimed", async () => {
  const src = source({ "in-progress": [file("racing", { plan: true })], queued: [] }, new Set(), {
    realFs: { "in-progress": [file("racing", { plan: true, claimed: true })] },
  })
  const { item } = await src.claimNext()
  assert.equal(item, null)
})

test("a claim is handed out with the real-FS body, not the stale listing's", async () => {
  const freshFile: FakeFile = {
    name: "evolving.md",
    content: `---\ntitle: evolving\npriority: 2\n---\n\nBody of evolving.\n\n${PLAN_HEADING}\n\n1. The fresh plan.\n`,
  }
  const src = source({ "in-progress": [file("evolving", { plan: true })], queued: [] }, new Set(), {
    realFs: { "in-progress": [freshFile] },
  })
  const { item } = await src.claimNext()
  assert.equal(item?.id, "evolving")
  assert.match(item?.state.artifacts.plan ?? "", /The fresh plan/)
})

test("taskGoal joins title and body", () => {
  assert.equal(taskGoal({ id: "x", title: "T", priority: 1, acceptance: [], body: "B", path: "/p" }), "T\n\nB")
})

test("claimSkipReason precedence: held beats empty beats started beats queued", () => {
  assert.match(claimSkipReason(0, 0, 0, [], ["h"]).message, /held/)
  assert.match(claimSkipReason(0, 0, 0, [], []).message, /both empty/)
  assert.match(claimSkipReason(2, 0, 0, ["a"], []).message, /already started/)
  assert.match(claimSkipReason(0, 0, 3, [], []).message, /3 task\(s\) awaiting a plan .*plan <id>/)
  assert.match(claimSkipReason(2, 0, 0, [], []).message, /no persisted plan/)
})
