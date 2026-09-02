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
 *
 * `requests` is the `.requests/` plan-request set, modelled well enough for the
 * claim walk to read, honour and spend one: `ls -1` lists it, `test -f`/`rm -f`
 * answer for a single marker, and a `mv` landing inside `.requests/` is a write.
 */
const fakeShell = (
  held: Set<string>,
  realFs: Record<string, FakeFile[]> = {},
  log?: string[],
  requests: Set<string> = new Set(),
): Shell => {
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
      // Each status folder owns its own `.requests/`, and only queued/ has one
      // here — a fake that answered for every status let the in-progress pool's
      // sweep delete the queued pool's requests.
      const parts = (cmd.split(" ").pop() ?? "").split("/")
      if (cmd.startsWith("ls -1 ") && cmd.endsWith("/.requests")) {
        const absent = parts[parts.length - 2] !== "queued" || requests.size === 0
        return absent ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: `${[...requests].join("\n")}\n` }
      }
      if (cmd.includes("/queued/.requests/")) {
        if (cmd.startsWith("test -f ")) return { exitCode: requests.has(id) ? 0 : 1, stdout: "" }
        if (cmd.startsWith("rm -f ")) {
          requests.delete(id)
          return { exitCode: 0, stdout: "" }
        }
        if (cmd.startsWith("mv ")) {
          requests.add(id)
          return { exitCode: 0, stdout: "" }
        }
      }
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

const file = (
  id: string,
  opts: { plan?: boolean; started?: boolean; claimed?: boolean; priority?: number; blockedBy?: readonly string[] } = {},
): FakeFile => {
  const plan = opts.plan ? `\n${PLAN_HEADING}\n\n1. Do the thing.\n` : ""
  const claimed = opts.claimed ? `\n> CLAIMED — loop starting [2026-01-01T00:00:00.000Z]\n` : ""
  const started = opts.started ? `\n> BUILD started (iteration 1) — 2026-01-01T00:00:00.000Z\n` : ""
  const blocked = opts.blockedBy?.length ? `blockedBy:\n${opts.blockedBy.map((b) => `  - ${b}`).join("\n")}\n` : ""
  return {
    name: `${id}.md`,
    content: `---\ntitle: ${id}\npriority: ${opts.priority ?? 2}\n${blocked}---\n\nBody of ${id}.\n${plan}${claimed}${started}`,
  }
}

const source = (
  folders: Record<string, FakeFile[]>,
  held = new Set<string>(),
  opts: { realFs?: Record<string, FakeFile[]>; shellLog?: string[]; requests?: Set<string> } = {},
) =>
  makeBacklogSource({
    // The client index and the real FS agree by default; pass `realFs` to
    // model an index that lags the real filesystem.
    $: fakeShell(held, opts.realFs ?? folders, opts.shellLog, opts.requests),
    client: fakeClient(folders),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: eng,
    isDriving: () => false,
  })

// --- blockedBy (design 49): a claim skips a task while a blocker is still on the board ---

test("a build-ready task blocked by an open sibling is skipped; the walk claims the sibling instead", async () => {
  const shellLog: string[] = []
  const src = source(
    {
      "in-progress": [file("stacked", { plan: true, priority: 0, blockedBy: ["base"] })],
      queued: [file("base")],
    },
    new Set<string>(),
    { shellLog },
  )
  const { item, skip } = await src.claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "base", "the blocker is planned; the blocked task waits")
  assert.ok(!shellLog.some((c) => c.startsWith("mkdir ") && c.includes("stacked")), "no claim marker is taken on a blocked task")
})

test("a blocker that completed, was abandoned, or never existed does not block", async () => {
  const cases: Record<string, FakeFile[]>[] = [
    { "in-progress": [file("stacked", { plan: true, blockedBy: ["base"] })], completed: [file("base")] },
    { "in-progress": [file("stacked", { plan: true, blockedBy: ["base"] })], abandoned: [file("base")] },
    { "in-progress": [file("stacked", { plan: true, blockedBy: ["never-written"] })] },
  ]
  for (const folders of cases) {
    const { item } = await source(folders).claimNext()
    assert.equal(item?.id, "stacked")
  }
})

test("a fully blocked backlog says what waits on what, not merely 'nothing claimable'", async () => {
  const src = source({
    "in-progress": [file("stacked", { plan: true, blockedBy: ["base"] })],
    "plan-review": [file("base", { plan: true })],
    queued: [file("later", { blockedBy: ["base", "stacked"] })],
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /2 task\(s\) blocked by open work: stacked \(waits on base\), later \(waits on base, stacked\)/)
  assert.equal(skip?.actionable, true)
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

test("a queued-only backlog is claimed and enters at PLAN", async () => {
  // The pool is walked like any other: an approved task waits for no verb.
  const shellLog: string[] = []
  const src = source({ "in-progress": [], queued: [file("plan-me")] }, new Set<string>(), { shellLog })
  const { item, skip } = await src.claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "plan-me")
  assert.equal(item?.entryStage, "plan")
  assert.match(item?.claimMessage ?? "", /planning…/)
  assert.ok(
    shellLog.some((c) => c.startsWith("mkdir ") && c.includes("queued/.claims/plan-me")),
    `the claim marker is taken, exactly as a build claim takes one: ${shellLog.join(" | ")}`,
  )
})

test("a claim-path PLAN entry carries the pending rejection reason", async () => {
  // The claim/watch path is the one most runs take, and its entry state used to
  // be built without `extractReplanReason` — plan.md's {{#replan}} section then
  // silently never rendered there, and the re-plan ran blind to why the human
  // rejected the last plan (the explicit `plan <id>` path threaded it fine).
  const rejected: FakeFile = {
    name: "replan-me.md",
    content:
      `---\ntitle: replan-me\npriority: 2\n---\n\nBody.\n\n${PLAN_HEADING}\n\n1. Old plan.\n` +
      `\n> Plan rejected — sent back to queued for re-planning — cache must be size-keyed [2026-01-02T00:00:00.000Z by dev]\n`,
  }
  const src = source({ "in-progress": [], queued: [rejected] })
  const { item } = await src.claimNext()
  assert.equal(item?.entryStage, "plan")
  assert.equal(item?.state.replan?.reason, "cache must be size-keyed")
})

test("a plan request wins the queued pool over a lower priority number", async () => {
  // The whole point of the hub's Plan button: "plan THIS one next" has to beat
  // the ordinary priority walk, or the click does nothing you can see.
  const requests = new Set(["asked-for"])
  const src = source(
    { "in-progress": [], queued: [file("would-win", { priority: 1 }), file("asked-for", { priority: 9 })] },
    new Set<string>(),
    { requests },
  )
  const { item } = await src.claimNext()
  assert.equal(item?.id, "asked-for")
  assert.equal(item?.entryStage, "plan")
  assert.deepEqual([...requests], [], "the hint is spent by the claim that honoured it")
})

test("two plan requests resolve among themselves by selectOrder", async () => {
  const src = source(
    {
      "in-progress": [],
      queued: [file("low", { priority: 1 }), file("asked-b", { priority: 5 }), file("asked-a", { priority: 3 })],
    },
    new Set<string>(),
    { requests: new Set(["asked-a", "asked-b"]) },
  )
  const { item } = await src.claimNext()
  assert.equal(item?.id, "asked-a", "requested-first is a stable partition, so priority still decides within the group")
})

test("a plan request does not preempt build-ready work — pool priority outranks it", async () => {
  // A request reorders its OWN pool. Letting it jump the manifest's pool order
  // would let a per-task marker invert declared priority and starve work that is
  // already approved and further along.
  const requests = new Set(["asked-for"])
  const src = source({ "in-progress": [file("build-me", { plan: true })], queued: [file("asked-for")] }, new Set<string>(), {
    requests,
  })
  const { item } = await src.claimNext()
  assert.equal(item?.id, "build-me")
  assert.deepEqual([...requests], ["asked-for"], "and the unspent request survives for a later tick")
})

test("a request whose claim is lost survives, so the next tick still prioritises it", async () => {
  const requests = new Set(["asked-for"])
  const src = source({ "in-progress": [], queued: [file("asked-for")] }, new Set(["asked-for"]), { requests })
  const { item } = await src.claimNext()
  assert.equal(item, null, "the marker is held by someone else")
  assert.deepEqual([...requests], ["asked-for"], "an unhonoured hint is not spent")
})

test("a request for a task that has left queued/ is swept rather than left reordering nothing", async () => {
  const requests = new Set(["gone", "still-here"])
  const src = source({ "in-progress": [], queued: [file("still-here")] }, new Set(["still-here"]), { requests })
  await src.claimNext()
  assert.deepEqual([...requests], ["still-here"], "only the stray goes; the live request is untouched")
})

test("a request whose task the lagging listing missed is never swept", async () => {
  // The client index lags the real FS (a just-approved task's mv not yet
  // reflected): the listing says queued/ is empty, but the task IS there. The
  // sweep must confirm every apparent stray against the real filesystem —
  // judging by the listing alone deleted a human's fresh ask.
  const requests = new Set(["fresh"])
  const src = source({ "in-progress": [], queued: [] }, new Set(), {
    realFs: { queued: [file("fresh")] },
    requests,
  })
  await src.claimNext()
  assert.deepEqual([...requests], ["fresh"], "the live request survives the sweep")
})

test("release restores a plan request the claim consumed", async () => {
  const requests = new Set(["asked-for"])
  const folders = { "in-progress": [], queued: [file("asked-for")] }
  const src = source(folders, new Set(), { requests })
  const { item } = await src.claimNext()
  assert.equal(item?.id, "asked-for")
  assert.equal(requests.has("asked-for"), false, "the hint was spent on the claim")
  await src.release(item!)
  assert.equal(requests.has("asked-for"), true, "a released claim did no work — the human's ask is restored")
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

test("release with the task gone from the pool still releases the claim-time marker", async () => {
  // The tryClaim catch releases when a drive died before real work started; if
  // the file has meanwhile left the pool (or no longer parses), skipping the
  // release leaves the pool's .claims/<id> marker held with no live owner —
  // and a held marker blocks every gate verb until the stale sweep.
  const folders = { "in-progress": [file("t", { plan: true })], queued: [] }
  const shellLog: string[] = []
  const src = source(folders, new Set<string>(), { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  folders["in-progress"] = []
  shellLog.length = 0
  await src.release(item)
  assert.ok(
    shellLog.some((c) => c.startsWith("rmdir") && c.includes(".claims/t")),
    `marker released via the claim-time ref: ${shellLog.join(" | ")}`,
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
  assert.equal(taskGoal({ id: "x", title: "T", priority: 1, acceptance: [], labels: [], blockedBy: [], body: "B", path: "/p" }), "T\n\nB")
})

test("claimSkipReason precedence: held beats empty beats started", () => {
  assert.match(claimSkipReason(0, 0, 0, [], ["h"]).message, /held/)
  assert.match(claimSkipReason(0, 0, 0, [], []).message, /both empty/)
  assert.match(claimSkipReason(2, 0, 0, ["a"], []).message, /already started/)
  assert.match(claimSkipReason(2, 0, 0, [], []).message, /no persisted plan/)
})

test("a queued task the index hasn't caught up on reports itself, and instructs nothing", () => {
  // This case used to fall through to the in-progress fallback and was pinned
  // there as "cosmetic, transient, deliberately not special-cased". The prose
  // was indeed cosmetic; the `actionable: true` riding it was not — the
  // OpenCode watcher toasts an actionable skip, so the human was told to run
  // `replan <id>` against an empty in-progress pool. It reports now, and stays
  // silent: transient conditions do not get a toast.
  const r = claimSkipReason(0, 0, 3, [], [])
  assert.match(r.message, /taken or moved before the claim landed/)
  assert.equal(r.actionable, false, "a transient re-list must not toast an instruction")
  assert.doesNotMatch(r.message, /replan/, "and must not name a verb for tasks that are not there")
  // The fallback keeps its wording for the case it was written for.
  assert.match(claimSkipReason(2, 0, 0, [], []).message, /no persisted plan/)
})

test("a build-ready task the index hasn't caught up on reports itself, and instructs nothing", () => {
  // The queued-pool twin of the test above, one pool over. `claimableCount` is
  // the count of in-progress bodies that PASSED the claim predicate, so a
  // positive one is proof those tasks carry a persisted plan — yet reaching
  // the skip reporter with it fell through to "in-progress task(s) have no
  // persisted plan (… replan <id>)", `actionable: true`, which the OpenCode
  // watcher toasts. Acting on that advice throws away a plan the human had
  // already approved. The condition is the same transient one: `claimFirst`
  // won a marker and `reverify` then found the file gone from the real FS.
  const r = claimSkipReason(2, 2, 0, [], [])
  assert.match(r.message, /taken or moved before the claim landed/)
  assert.equal(r.actionable, false, "a transient re-list must not toast an instruction")
  assert.doesNotMatch(r.message, /replan/, "and must never propose discarding an approved plan")
  // Held markers still outrank it — a held claim is the actionable case.
  assert.match(claimSkipReason(2, 2, 0, [], ["h"]).message, /held/)
  // And a started-but-unclaimed pool still routes to recover, not to this arm.
  assert.match(claimSkipReason(2, 0, 0, ["a"], []).message, /already started/)
})
