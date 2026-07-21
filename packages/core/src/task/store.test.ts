import assert from "node:assert/strict"
import { test } from "node:test"
import { serializeTask, type Task } from "./schema.js"
import {
  auditNote,
  canTransition,
  claimFirst,
  claimOlderThan,
  extractPlan,
  findByIdIn,
  hasPlan,
  isClaimable,
  isOrphanedClaim,
  isRecoverable,
  listClaimIds,
  markClaimed,
  moveTask,
  pairingCoverage,
  PLAN_HEADING,
  releaseOrphanedClaims,
  resolveTaskIdAnywhere,
  resolveTaskIdIn,
  selectNext,
  selectOrder,
  statusOf,
  STATUSES,
  writeTask,
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

// --- CLAIMED marker: durable claim evidence on the human-visible branch ---
// Isolation commits BUILD notes onto feature/<id>; without this marker the
// human branch's task file looks untouched after a full run and the watcher
// re-claims a task whose work already ran (the theater-booking-0 bug).

test("isClaimable is false once a CLAIMED note is on the body, even with zero build markers", () => {
  const at = new Date("2026-07-13T08:31:53.000Z")
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> ${auditNote("CLAIMED — loop starting", at, "w")}`
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isRecoverable is true for a planned task with only a CLAIMED note (crashed before BUILD)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> CLAIMED — loop starting [2026-07-13T08:31:53.000Z]`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isOrphanedClaim is false once CLAIMED landed — the sweep must not release a run's marker", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> CLAIMED — loop starting [2026-07-13T08:31:53.000Z]`
  assert.equal(isOrphanedClaim(task("a", 0, body), { drivenByLiveLoop: false, markerStale: true }), false)
})

test("markClaimed appends the CLAIMED audit note to the task file", async () => {
  const cmds: string[] = []
  const $ = makeShell(() => ({}), cmds)
  await markClaimed($, task("a", 0), "Alice <alice@acme.com>")
  assert.ok(
    cmds.some((c) => c.includes("CLAIMED — loop starting") && c.includes("by Alice")),
    `no CLAIMED append in: ${cmds.join(" | ")}`,
  )
})

// --- lifecycle window: only markers after the LAST plan approval are state ---
// Audit notes survive a replan, so a task that built once (cap-trip/crash →
// replan → re-plan → re-approve) must become claimable again once its new plan
// is approved — the old attempt's CLAIMED/BUILD notes are history.

const replannedBody = [
  `${PLAN_HEADING}\n\n1. Old plan.`,
  "> Plan approved — parked for execution [2026-07-12T08:00:00.000Z by w]",
  "> CLAIMED — loop starting [2026-07-12T08:01:00.000Z by w]",
  "> BUILD started (iteration 1) [2026-07-12T08:02:00.000Z by w]",
  "> Plan rejected — sent back to queued for re-planning [2026-07-12T09:00:00.000Z by w]",
  `${PLAN_HEADING}\n\n1. New plan.`,
].join("\n\n")

test("isClaimable becomes true again after a replanned task's NEW plan is approved", () => {
  const reApproved = `${replannedBody}\n\n> Plan approved — parked for execution [2026-07-13T10:00:00.000Z by w]`
  assert.equal(isClaimable(task("a", 0, reApproved)), true)
  assert.equal(isRecoverable(task("a", 0, reApproved)), false)
  assert.equal(wasInterrupted(task("a", 0, reApproved)), false, "the old unmatched BUILD start is history, not an interruption")
})

test("a replanned task awaiting re-approval still reads the old markers (whole-body fallback)", () => {
  // No new "Plan approved" yet — the window anchors at the FIRST approval, so the
  // old attempt's markers still count and nothing claims it early.
  assert.equal(isClaimable(task("a", 0, replannedBody)), false)
})

test("markers appended after the latest approval make the task un-claimable and recoverable again", () => {
  const reclaimed = [
    replannedBody,
    "> Plan approved — parked for execution [2026-07-13T10:00:00.000Z by w]",
    "> CLAIMED — loop starting [2026-07-13T10:05:00.000Z by w]",
    "> BUILD started (iteration 1) [2026-07-13T10:06:00.000Z by w]",
  ].join("\n\n")
  assert.equal(isClaimable(task("a", 0, reclaimed)), false)
  assert.equal(isRecoverable(task("a", 0, reclaimed)), true)
  assert.equal(wasInterrupted(task("a", 0, reclaimed)), true, "an unmatched BUILD start in the current window IS an interruption")
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

// --- summarizeBacklog (the /agentic-loop:engineering status roll-up) ---

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
  assert.deepEqual(s.awaitingTask, [])
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

test("summarizeBacklog flags approvable drafts and excludes the never-approve tracking epic", () => {
  const byStatus = empty()
  byStatus["draft"] = [task("real", 0, "an idea"), { ...task("tracker", 0, "slices"), type: "epic" }]
  const s = summarizeBacklog(byStatus)
  assert.equal(s.counts["draft"], 2)
  assert.deepEqual(s.awaitingTask, ["real"])
})

// --- pairingCoverage (the loop_status pairing view) ---

const paired = (id: string): Task => ({ ...task(id, 0), tracker: { system: "jira", key: `PROJ-${id}` } })

test("pairingCoverage counts paired active tasks and lists the unpaired, sorted", () => {
  const byStatus = empty()
  byStatus["draft"] = [task("zed", 0), paired("d1")]
  byStatus["queued"] = [task("alpha", 0)]
  byStatus["in-progress"] = [paired("p1")]
  const cov = pairingCoverage(byStatus)
  assert.equal(cov.paired, 2)
  assert.deepEqual(cov.unpaired, ["alpha", "zed"])
})

test("pairingCoverage ignores completed and abandoned tasks", () => {
  const byStatus = empty()
  byStatus["completed"] = [task("done", 0)]
  byStatus["abandoned"] = [task("dropped", 0)]
  const cov = pairingCoverage(byStatus)
  assert.equal(cov.paired, 0)
  assert.deepEqual(cov.unpaired, [])
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
  // `test -e dest` fails (no duplicate); everything else succeeds.
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const dest = await moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued")
  assert.equal(dest, "/r/docs/tasks/queued/a.md")
  assert.ok(log.some((cmd) => cmd.startsWith("mv ")))
})

test("moveTask refuses to clobber an existing duplicate id at the destination", async () => {
  // `test -e dest` succeeds — a same-id file already lives in the destination
  // folder. The mv would silently destroy it, so moveTask must throw first.
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued"),
    /queued\/a\.md already exists/,
  )
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no mv was attempted")
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

test("moveTask throws when mv reports success but the file did not land", async () => {
  // mv exits 0, but the post-move `test -f dest` fails — a false success must throw.
  // (`test -e` also fails: no pre-existing duplicate at the destination.)
  const $ = makeShell((cmd) => (cmd.startsWith("test -") ? { exitCode: 1 } : { exitCode: 0 }))
  await assert.rejects(
    () => moveTask($, { id: "a", path: "/r/docs/tasks/draft/a.md" }, "queued"),
    /did not land at .*queued\/a\.md/,
  )
})

// --- findByIdIn: shell-authoritative resolution (reads the real FS via `cat`) ---

test("findByIdIn resolves a task by cat-ing its absolute path", async () => {
  const content = serializeTask({ title: "Do it", body: "context" })
  const $ = makeShell((cmd) => (cmd === "cat /r/docs/tasks/queued/a.md" ? { exitCode: 0, stdout: content } : { exitCode: 1 }))
  const found = await findByIdIn($, "/r", "docs/tasks", "queued", "a")
  assert.equal(found?.id, "a")
  assert.equal(found?.path, "/r/docs/tasks/queued/a.md")
  assert.equal(found?.title, "Do it")
})

test("findByIdIn returns null when cat exits non-zero (file absent)", async () => {
  const $ = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await findByIdIn($, "/r", "docs/tasks", "queued", "missing"), null)
})

test("findByIdIn returns null and warns on unparseable content", async () => {
  const warnings: string[] = []
  const $ = makeShell(() => ({ exitCode: 0, stdout: "not a task file" }))
  const found = await findByIdIn($, "/r", "docs/tasks", "queued", "a", (level, msg) => {
    if (level === "warn") warnings.push(msg)
  })
  assert.equal(found, null)
  assert.equal(warnings.length, 1)
})

// --- resolveTaskIdIn: exact hit, short-hash prefix, ambiguity, legacy back-compat ---

/** A fake shell for `cat <dir>/<name>.md` (present in `files`) and `ls <dir>`. */
const idResolverShell = (dir: string, files: string[]) =>
  makeShell((cmd) => {
    if (cmd.startsWith("cat ")) {
      const name = cmd.slice(`cat ${dir}/`.length).replace(/\.md$/, "")
      return files.includes(name) ? { exitCode: 0, stdout: "x" } : { exitCode: 1 }
    }
    if (cmd === `ls ${dir}`) return { exitCode: 0, stdout: files.map((f) => `${f}.md`).join("\n") }
    return { exitCode: 1 }
  })

const QDIR = "/r/docs/tasks/queued"

test("resolveTaskIdIn resolves an exact full id", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "a1b2-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3-add-foo"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn resolves a legacy slug id by exact filename (back-compat)", async () => {
  const $ = idResolverShell(QDIR, ["add-rate-limiting"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "add-rate-limiting"), { id: "add-rate-limiting" })
})

test("resolveTaskIdIn resolves a unique short-hash prefix", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "a1b2-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k"), { id: "f7k3-add-foo" })
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn reports ambiguity when a prefix matches several", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "fa2b-do-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f"), { ambiguous: ["f7k3-add-foo", "fa2b-do-bar"] })
})

test("resolveTaskIdIn disambiguates a colliding hash by a longer full-id prefix", async () => {
  // Two tasks share the 4-char hash f7k3: the bare hash is ambiguous, but a longer
  // prefix of the full id resolves the one — so "Use more characters" actually works.
  const $ = idResolverShell(QDIR, ["f7k3-add-foo", "f7k3-fix-bar"])
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3"), {
    ambiguous: ["f7k3-add-foo", "f7k3-fix-bar"],
  })
  assert.deepEqual(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "f7k3-add"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdIn never treats a legacy slug as a hash prefix", async () => {
  // "add-rate-limiting" is not a modern <hash>- id, so a bare "add" prefix must not match it.
  const $ = idResolverShell(QDIR, ["add-rate-limiting"])
  assert.equal(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "add"), null)
})

test("resolveTaskIdIn returns null when nothing matches", async () => {
  const $ = idResolverShell(QDIR, ["f7k3-add-foo"])
  assert.equal(await resolveTaskIdIn($, "/r", "docs/tasks", "queued", "zzzz"), null)
})

// --- resolveTaskIdAnywhere (cross-status: what plan/recover/loop_start accept) ---

/** A fake shell over several status folders at once: `dirs` maps folder path → filenames. */
const multiDirShell = (dirs: Record<string, string[]>) =>
  makeShell((cmd) => {
    if (cmd.startsWith("cat ")) {
      const file = cmd.slice("cat ".length)
      const dir = file.slice(0, file.lastIndexOf("/"))
      const name = file.slice(dir.length + 1).replace(/\.md$/, "")
      return dirs[dir]?.includes(name) ? { exitCode: 0, stdout: "x" } : { exitCode: 1 }
    }
    if (cmd.startsWith("ls ")) {
      const dir = cmd.slice("ls ".length)
      const files = dirs[dir]
      return files ? { exitCode: 0, stdout: files.map((f) => `${f}.md`).join("\n") } : { exitCode: 1 }
    }
    return { exitCode: 1 }
  })

test("resolveTaskIdAnywhere resolves a short-hash handle whichever folder the task is in", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"], "/r/docs/tasks/in-progress": ["a1b2-do-bar"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f7k3"), { id: "f7k3-add-foo" })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "a1b2"), { id: "a1b2-do-bar" })
})

test("resolveTaskIdAnywhere: an exact full id wins immediately", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f7k3-add-foo"), { id: "f7k3-add-foo" })
})

test("resolveTaskIdAnywhere merges prefix hits across folders into an ambiguity", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"], "/r/docs/tasks/draft": ["fa2b-do-bar"] })
  assert.deepEqual(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "f"), { ambiguous: ["f7k3-add-foo", "fa2b-do-bar"] })
})

test("resolveTaskIdAnywhere returns null for an unknown id and an empty query", async () => {
  const $ = multiDirShell({ "/r/docs/tasks/queued": ["f7k3-add-foo"] })
  assert.equal(await resolveTaskIdAnywhere($, "/r", "docs/tasks", "zzzz"), null)
  assert.equal(await resolveTaskIdAnywhere($, "/r", "docs/tasks", ""), null)
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

test("claimFirst hands out the fresh task from reverify, not the stale listing", async () => {
  const $ = claimShell(new Set(), new Set())
  const fresh = task("a", 1, `${PLAN_HEADING}\n\n1. Go — updated.`)
  const { claimed } = await claimFirst($, [planned("a", 1)], {
    ...notDriving,
    reverify: async () => fresh,
  })
  assert.equal(claimed, fresh)
})

test("claimFirst releases a stale claim when reverify says the task is gone, and moves on", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(), new Set(), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], {
    ...notDriving,
    reverify: async (t) => (t.id === "a" ? null : t),
  })
  assert.equal(claimed?.id, "b")
  // a's marker was created and then released; a is NOT held — nothing owns it.
  assert.ok(log.some((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/a")))
  assert.deepEqual(heldIds, [])
})

test("claimFirst returns nothing when reverify drops every candidate", async () => {
  const $ = claimShell(new Set(), new Set())
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1), planned("b", 2)], {
    ...notDriving,
    reverify: async () => null,
  })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, [])
})

test("claimFirst reverifies the orphan-release retry win too", async () => {
  const log: string[] = []
  const $ = claimShell(new Set(["a"]), new Set(["a"]), log)
  const { claimed, heldIds } = await claimFirst($, [planned("a", 1)], {
    ...notDriving,
    reverify: async () => null,
  })
  assert.equal(claimed, null)
  assert.deepEqual(heldIds, [])
  // Two rmdirs of a: the orphan release, then the reverify drop of the retry win.
  assert.equal(log.filter((cmd) => cmd.startsWith("rmdir ") && cmd.endsWith("/a")).length, 2)
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

// --- writeTask must never clobber an existing task file ---

/** A client whose file.list reports `ids` for every status folder. */
const idsClient = (ids: string[]) =>
  ({
    file: {
      list: async () => ({ data: ids.map((id) => ({ name: `${id}.md`, type: "file" })) }),
    },
  }) as unknown as Parameters<typeof writeTask>[1]

test("writeTask refuses to overwrite a file already at the destination", async () => {
  // Uniqueness comes only from `taken`, gathered via the client index — which
  // findByIdIn's own doc comment says can lag the real FS. When it does,
  // buildTaskFile re-mints the same id and writeFileAtomic's `mv` clobbers the
  // other task's file and audit trail with no error. Every sibling write path
  // (moveTask, rescueStray) guards first; this one did not.
  const cmds: string[] = []
  // Index reports nothing taken, but the destination exists on the real FS.
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 0 } : {}), cmds)
  await assert.rejects(
    () => writeTask($, idsClient([]), { directory: "/r" }, { title: "Add rate limiting", priority: 2 }),
    /already exists/,
  )
  assert.ok(!cmds.some((c) => c.startsWith("mv ")), "no write attempted after the collision check")
})

test("writeTask writes when the destination is free", async () => {
  const cmds: string[] = []
  const $ = makeShell((cmd) => (cmd.startsWith("test -e") ? { exitCode: 1 } : {}), cmds)
  const out = await writeTask($, idsClient([]), { directory: "/r" }, { title: "Add rate limiting", priority: 2 })
  assert.match(out.path, /\/r\/docs\/tasks\/draft\/.*\.md$/)
  assert.ok(out.id)
})
