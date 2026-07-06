import assert from "node:assert/strict"
import { test } from "node:test"
import type { Task } from "./schema.js"
import {
  auditNote,
  canTransition,
  claimFirst,
  claimOlderThan,
  extractPlan,
  hasPlan,
  isClaimable,
  isOrphanedClaim,
  isRecoverable,
  listClaimIds,
  moveTask,
  PLAN_HEADING,
  releaseOrphanedClaims,
  selectNext,
  selectOrder,
  statusOf,
  STATUSES,
  summarizeBacklog,
  type TaskStatus,
  wasInterrupted,
} from "./store.js"

/**
 * store.ts shells out via Bun's `$` for moveTask (mkdir/mv), which the
 * node+tsx test runner can't execute. Mirrors the fake shell in
 * `../loop/git.test.ts`.
 */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }

const makeShell = (handler: (cmd: string) => FakeResult, log?: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log?.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const task = (id: string, priority: number, body = ""): Task => ({
  id,
  title: id,
  priority,
  acceptance: [],
  body,
  path: `/r/docs/tasks/in-progress/${id}.md`,
})

test("selectNext returns null for an empty backlog", () => {
  assert.equal(selectNext([]), null)
})

test("selectNext picks the lowest priority number first", () => {
  const picked = selectNext([task("b", 5), task("a", 2), task("c", 9)])
  assert.equal(picked?.id, "a")
})

test("selectNext breaks priority ties by id", () => {
  const picked = selectNext([task("zebra", 1), task("apple", 1)])
  assert.equal(picked?.id, "apple")
})

test("selectNext does not mutate the input array", () => {
  const tasks = [task("b", 5), task("a", 2)]
  selectNext(tasks)
  assert.equal(tasks[0]?.id, "b")
})

test("hasPlan is false when the body has no plan heading", () => {
  assert.equal(hasPlan(task("a", 0, "Some description.")), false)
})

test("hasPlan is true once the plan heading is present", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(hasPlan(task("a", 0, body)), true)
})

test("extractPlan returns undefined when there is no plan heading", () => {
  assert.equal(extractPlan(task("a", 0, "Some description.")), undefined)
})

test("extractPlan returns the text after the heading, trimmed", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.\n2. Test it.`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.\n2. Test it.")
})

test("wasInterrupted is false when there is no build marker", () => {
  assert.equal(wasInterrupted(task("a", 0, "Some description.")), false)
})

test("wasInterrupted is false when the last start has a matching finish", () => {
  const body = "> BUILD started (iteration 1)\n> BUILD finished (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), false)
})

test("wasInterrupted is true when a start has no matching finish", () => {
  const body = "> BUILD started (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("wasInterrupted is true when only the latest pair is unmatched", () => {
  const body = [
    "> BUILD started (iteration 1)",
    "> BUILD finished (iteration 1)",
    "> BUILD started (iteration 2)",
  ].join("\n")
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("isClaimable is false when there is no plan", () => {
  assert.equal(isClaimable(task("a", 0, "Some description.")), false)
})

test("isClaimable is false when a plan exists but a build already started and finished", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is false when a plan exists and the last build start is unmatched (interrupted)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  // Distinct from wasInterrupted, which is also true here — isClaimable cares
  // about ANY build marker, not just whether the last pair is unmatched.
  assert.equal(wasInterrupted(task("a", 0, body)), true)
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is true when a plan exists and there are zero build markers", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isClaimable(task("a", 0, body)), true)
})

test("isRecoverable is false when there is no plan", () => {
  assert.equal(isRecoverable(task("a", 0, "> BUILD started (iteration 1)")), false)
})

test("isRecoverable is false when a planned task was never started", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isRecoverable(task("a", 0, body)), false)
})

test("isRecoverable is true once a planned task has any build marker", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isRecoverable stays true after a matched finish (recover is for any stuck started task)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("auditNote suffixes the timestamp and actor", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  assert.equal(
    auditNote("BUILD started (iteration 1)", at, "Alice <alice@acme.com>"),
    "BUILD started (iteration 1) [2026-07-03T05:00:00.000Z by Alice <alice@acme.com>]",
  )
})

test("auditNote omits the actor when unknown", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  assert.equal(auditNote("Loop stopped", at, null), "Loop stopped [2026-07-03T05:00:00.000Z]")
})

test("audit-suffixed build markers still satisfy the claim/interrupt greps", () => {
  const at = new Date("2026-07-03T05:00:00.000Z")
  const started = `> ${auditNote("BUILD started (iteration 1)", at, "w")}`
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n${started}`
  assert.equal(isClaimable(task("a", 0, body)), false)
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

// --- summarizeBacklog (the /agent-loop status roll-up) ---

const empty = () =>
  Object.fromEntries(STATUSES.map((s) => [s, []])) as unknown as Record<TaskStatus, ReturnType<typeof task>[]>

test("summarizeBacklog counts every status and empty flag lists", () => {
  const s = summarizeBacklog(empty())
  assert.deepEqual(s.counts, {
    draft: 0,
    queued: 0,
    "plan-review": 0,
    "in-progress": 0,
    "in-review": 0,
    completed: 0,
    abandoned: 0,
  })
  assert.deepEqual(s.awaitingPlan, [])
  assert.deepEqual(s.gated, [])
  assert.deepEqual(s.claimable, [])
  assert.deepEqual(s.interrupted, [])
  assert.deepEqual(s.awaitingReview, [])
})

test("summarizeBacklog flags queued, gated plan-review, and in-progress/in-review states", () => {
  const byStatus = empty()
  byStatus["queued"] = [task("planme", 0, "just an idea")]
  byStatus["plan-review"] = [task("gated", 0, `${PLAN_HEADING}\n\n1. Go.`)]
  byStatus["in-progress"] = [
    task("ready", 0, `${PLAN_HEADING}\n\n1. Go.`),
    task("crashed", 0, `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)`),
  ]
  byStatus["in-review"] = [task("shipme", 0, "")]
  const s = summarizeBacklog(byStatus)
  assert.equal(s.counts["queued"], 1)
  assert.equal(s.counts["plan-review"], 1)
  assert.deepEqual(s.awaitingPlan, ["planme"])
  assert.deepEqual(s.gated, ["gated"])
  assert.deepEqual(s.claimable, ["ready"])
  assert.deepEqual(s.interrupted, ["crashed"])
  assert.deepEqual(s.awaitingReview, ["shipme"])
})

// --- canTransition / statusOf / moveTask (stage-order enforcement) ---

test("canTransition allows each adjacent forward hop", () => {
  assert.equal(canTransition("draft", "queued"), true)
  assert.equal(canTransition("queued", "plan-review"), true)
  assert.equal(canTransition("plan-review", "in-progress"), true)
  assert.equal(canTransition("in-progress", "in-review"), true)
  assert.equal(canTransition("in-review", "completed"), true)
})

test("canTransition rejects any forward skip", () => {
  assert.equal(canTransition("draft", "in-progress"), false)
  assert.equal(canTransition("draft", "in-review"), false)
  assert.equal(canTransition("draft", "completed"), false)
  assert.equal(canTransition("queued", "in-progress"), false)
  assert.equal(canTransition("plan-review", "completed"), false)
  assert.equal(canTransition("in-progress", "completed"), false)
})

test("canTransition rejects backward moves except the replan escape", () => {
  assert.equal(canTransition("in-progress", "draft"), false)
  assert.equal(canTransition("in-review", "plan-review"), false)
  assert.equal(canTransition("in-review", "queued"), false)
  assert.equal(canTransition("completed", "in-review"), false)
})

test("canTransition allows the replan escape back to queued", () => {
  assert.equal(canTransition("plan-review", "queued"), true)
  assert.equal(canTransition("in-progress", "queued"), true)
})

test("canTransition allows abandoning any active stage", () => {
  assert.equal(canTransition("draft", "abandoned"), true)
  assert.equal(canTransition("queued", "abandoned"), true)
  assert.equal(canTransition("plan-review", "abandoned"), true)
  assert.equal(canTransition("in-progress", "abandoned"), true)
  assert.equal(canTransition("in-review", "abandoned"), true)
})

test("canTransition treats completed and abandoned as terminal", () => {
  assert.equal(canTransition("completed", "abandoned"), false)
  assert.equal(canTransition("abandoned", "in-progress"), false)
  assert.equal(canTransition("abandoned", "abandoned"), false)
})

test("statusOf derives the status from the task's containing folder", () => {
  assert.equal(statusOf({ id: "a", path: "/r/docs/tasks/draft/a.md" }), "draft")
  assert.equal(statusOf({ id: "a", path: "/r/docs/tasks/in-review/a.md" }), "in-review")
})

test("statusOf throws for a path outside a known status folder", () => {
  assert.throws(() => statusOf({ id: "a", path: "/r/docs/tasks/wherever/a.md" }))
})

test("moveTask succeeds on a valid adjacent hop and records the mv", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  const dest = await moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued")
  assert.equal(dest, "/r/docs/tasks/queued/a.md")
  assert.ok(log.some((cmd) => cmd.startsWith("mv ")))
})

test("moveTask throws on a stage-skip attempt without touching the shell", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "in-progress"),
    /cannot move a from draft to in-progress/,
  )
  assert.deepEqual(log, [])
})

// --- selectOrder (the claim walk's candidate ordering) ---

test("selectOrder sorts by priority then id and does not mutate the input", () => {
  const tasks = [task("zebra", 1), task("b", 5), task("apple", 1)]
  const ordered = selectOrder(tasks)
  assert.deepEqual(
    ordered.map((t) => t.id),
    ["apple", "zebra", "b"],
  )
  assert.equal(tasks[0]?.id, "zebra")
})

test("selectNext equals the head of selectOrder", () => {
  const tasks = [task("b", 5), task("a", 2)]
  assert.equal(selectNext(tasks)?.id, selectOrder(tasks)[0]?.id)
})

// --- claim markers: staleness, orphan detection, and the claim walk ---

const planned = (id: string, priority = 0) => task(id, priority, `${PLAN_HEADING}\n\n1. Go.`)
const started = (id: string, priority = 0) => task(id, priority, `${PLAN_HEADING}\n\n1. Go.\n\n> BUILD started (iteration 1)`)

test("isOrphanedClaim requires claimable body, no live loop, and a stale marker", () => {
  const ok = { drivenByLiveLoop: false, markerStale: true }
  assert.equal(isOrphanedClaim(planned("a"), ok), true)
  assert.equal(isOrphanedClaim(started("a"), ok), false)
  assert.equal(isOrphanedClaim(planned("a"), { ...ok, drivenByLiveLoop: true }), false)
  assert.equal(isOrphanedClaim(planned("a"), { ...ok, markerStale: false }), false)
})

test("claimOlderThan is true only when find exits 0 and prints the marker path", async () => {
  const stale = makeShell(() => ({ exitCode: 0, stdout: "/r/docs/tasks/in-progress/.claims/a\n" }))
  assert.equal(await claimOlderThan(stale, task("a", 0), 15), true)
  const absent = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await claimOlderThan(absent, task("a", 0), 15), false)
  const fresh = makeShell(() => ({ exitCode: 0, stdout: "" }))
  assert.equal(await claimOlderThan(fresh, task("a", 0), 15), false)
})

test("listClaimIds parses ls output and returns [] when the folder is absent", async () => {
  const some = makeShell((cmd) => (cmd.startsWith("ls -1") ? { exitCode: 0, stdout: "a\nb\n\n" } : { exitCode: 0 }))
  assert.deepEqual(await listClaimIds(some, "/r", "docs/tasks"), ["a", "b"])
  const none = makeShell(() => ({ exitCode: 1 }))
  assert.deepEqual(await listClaimIds(none, "/r", "docs/tasks"), [])
})

/**
 * Shell for claim walks: per-id mkdir failures (held markers), per-id find
 * staleness, and stateful release — after an `rmdir` of a marker, the next
 * `mkdir` of it succeeds, like the real filesystem.
 */
const claimShell = (held: Set<string>, stale: Set<string>, log?: string[]) =>
  makeShell((cmd) => {
    const id = cmd.split("/").pop() ?? ""
    if (cmd.startsWith("mkdir -p")) return { exitCode: 0 }
    if (cmd.startsWith("mkdir ")) return { exitCode: held.has(id) ? 1 : 0 }
    if (cmd.startsWith("rmdir ")) {
      held.delete(id)
      return { exitCode: 0 }
    }
    if (cmd.startsWith("find ")) {
      const markerId = cmd.split(" ")[1]?.split("/").pop() ?? ""
      return stale.has(markerId) ? { exitCode: 0, stdout: `.claims/${markerId}\n` } : { exitCode: 0, stdout: "" }
    }
    return { exitCode: 0 }
  }, log)

const notDriving = { isDriving: () => false }

test("claimFirst claims the first candidate when its marker is free", async () => {
  const $ = claimShell(new Set(), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "a")
  assert.deepEqual(heldIds, [])
})

test("claimFirst skips a held (fresh) marker and claims the next candidate", async () => {
  const $ = claimShell(new Set(["a"]), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "b")
  assert.deepEqual(heldIds, ["a"])
})

test("claimFirst releases a stale orphaned marker and claims that task on retry", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed?.id, "a")
  assert.deepEqual(heldIds, [])
  assert.ok(log.some((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/a")))
})

test("claimFirst never releases a stale marker whose task a live loop drives", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], { isDriving: (id) => id === "a" })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a"])
  assert.ok(!log.some((cmd) => cmd.startsWith("rmdir ")))
})

test("claimFirst returns every held id in order when all claims fail", async () => {
  const $ = claimShell(new Set(["a", "b"]), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], notDriving)
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a", "b"])
})

test("claimFirst treats a lost release-retry race as held", async () => {
  // rmdir "succeeds" but another instance re-claims instantly: mkdir keeps failing.
  const $ = makeShell((cmd) => {
    if (cmd.startsWith("mkdir -p")) return { exitCode: 0 }
    if (cmd.startsWith("mkdir ")) return { exitCode: 1 }
    if (cmd.startsWith("find ")) return { exitCode: 0, stdout: ".claims/a\n" }
    return { exitCode: 0 }
  })
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], notDriving)
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, ["a"])
})

test("releaseOrphanedClaims releases stale orphans and taskless markers, keeps the rest", async () => {
  const log: string[] = []
  const stale = new Set(["orphan", "ghost", "crashed"])
  const $ = makeShell((cmd) => {
    if (cmd.startsWith("find ")) {
      const markerId = cmd.split(" ")[1]?.split("/").pop() ?? ""
      return stale.has(markerId) ? { exitCode: 0, stdout: `.claims/${markerId}\n` } : { exitCode: 0, stdout: "" }
    }
    return { exitCode: 0 }
  }, log)
  const inProgress = [planned("orphan"), planned("fresh"), started("crashed")]
  const released = await releaseOrphanedClaims(
    $,
    inProgress,
    ["orphan", "fresh", "crashed", "ghost"],
    "/r/docs/tasks/in-progress",
    { isDriving: () => false },
  )
  // orphan: claimable + stale → released. fresh: not stale → kept.
  // crashed: BUILD started → recover territory, kept. ghost: no task file, stale → released.
  assert.deepEqual(released, ["orphan", "ghost"])
  const rmdirs = log.filter((cmd) => cmd.startsWith("rmdir "))
  assert.equal(rmdirs.length, 2)
})

test("summarizeBacklog splits body-claimable tasks into ready vs claim-held", () => {
  const byStatus = empty()
  byStatus["in-progress"] = [planned("free"), planned("blocked")]
  const s = summarizeBacklog(byStatus, ["blocked"])
  assert.deepEqual(s.claimable, ["free"])
  assert.deepEqual(s.claimHeld, ["blocked"])
})

test("summarizeBacklog without claimedIds reports every body-claimable task as ready", () => {
  const byStatus = empty()
  byStatus["in-progress"] = [planned("free")]
  const s = summarizeBacklog(byStatus)
  assert.deepEqual(s.claimable, ["free"])
  assert.deepEqual(s.claimHeld, [])
})
