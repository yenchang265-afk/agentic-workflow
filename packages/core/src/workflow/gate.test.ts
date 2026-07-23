import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import { approveAny, approvePlan, approveTask, rejectAny, removeTask, replanTask, retaskTask, shipTask, type GateCtx } from "./gate.js"

/**
 * The shared gate moves, driven against a tiny in-memory backlog. A fake shell
 * models `cat`/`mv` over a file map (the id-based ops need only those); git
 * commands report "no branch/actor" so ship attempts no PR. The no-id
 * `resolveGateTask` path — tier priority, the draft fallback, and the epic skip
 * — is covered end-to-end by the OpenCode driver tests, which back the fake
 * client's directory listing with a real file map.
 */
const makeCtx = (
  files: Record<string, string>,
  opts: { driving?: string; git?: (cmd: string) => { exitCode: number; stdout: string } | undefined } = {},
) => {
  const fs: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) fs[`/repo/docs/tasks/${k}`] = v
  const log: string[] = []
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += Array.isArray(exprs[i]) ? (exprs[i] as unknown[]).join(" ") : String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    log.push(norm)
    const parts = norm.split(" ")
    let out = { exitCode: 0, stdout: "" }
    if (parts[0] === "cat") out = parts[1]! in fs ? { exitCode: 0, stdout: fs[parts[1]!]! } : { exitCode: 1, stdout: "" }
    else if (parts[0] === "test") out = parts[2]! in fs ? { exitCode: 0, stdout: "" } : { exitCode: 1, stdout: "" }
    else if (parts[0] === "mv") {
      const [, src, dest] = parts
      if (src! in fs) {
        fs[dest!] = fs[src!]!
        delete fs[src!]
      } else out = { exitCode: 1, stdout: "" }
    } else if (parts[0] === "rm") {
      // rm [-f] <path…> — drop any listed paths (missing is fine under -f).
      for (const p of parts.slice(1)) if (p !== "-f" && p in fs) delete fs[p]
    } else if (parts[0] === "ls") {
      const dir = parts.slice(1).find((p) => !p.startsWith("-"))! // skip flags like `-1`
      const names = Object.keys(fs)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1))
      out = { exitCode: 0, stdout: names.join("\n") }
    } else if (parts[0] === "git") out = opts.git?.(norm) ?? { exitCode: 1, stdout: "" } // default: no actor, no branch → no PR
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  const ctx: GateCtx = {
    $,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: { file: { list: async () => ({ data: [] }), read: async () => ({ data: null }) }, app: { log: async () => undefined } } as any,
    log: () => {},
    directory: "/repo",
    config: DEFAULT_CONFIG,
    isDriving: (id) => id === opts.driving,
  }
  return { ctx, fs, log }
}

const task = (title: string, body = "context") => serializeTask({ title, body })

// --- retaskTask: place a planless task where the authoring interview can reshape it ---

test("retaskTask on a draft is an idempotent no-op — it is already in place", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.alreadyDone === true)
  assert.ok("/repo/docs/tasks/draft/t.md" in fs)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "nothing to move")
})

test("retaskTask sends an approved queued task back to draft, audited and committed", async () => {
  const { ctx, fs, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.retask === true && r.data.alreadyDone === undefined)
  assert.match(r.message, /draft/)
  assert.ok("/repo/docs/tasks/draft/t.md" in fs, "the file lands in draft/")
  assert.ok(!("/repo/docs/tasks/queued/t.md" in fs), "and leaves queued/")
  // The audit note records WHY it went back; the commit itself is out of reach
  // here (the harness's git stub reports no actor), same as approveTask's test.
  assert.ok(log.some((c) => c.includes("approval withdrawn")), "an audit note is appended")
})

test("retaskTask refuses a parked plan and names replan", async () => {
  const { ctx, fs, log } = makeCtx({ "plan-review/t.md": task("Planned", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /replan/)
  assert.ok("/repo/docs/tasks/plan-review/t.md" in fs, "untouched")
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("retaskTask refuses an in-progress task — its plan is already being built", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Building", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /replan/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs)
})

test("retaskTask refuses a task a live loop is driving", async () => {
  const { ctx, fs } = makeCtx({ "queued/t.md": task("Do it") }, { driving: "t" })
  const r = await retaskTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /live loop/)
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "never yanked out from under a running PLAN")
})

test("retaskTask reports a missing id rather than inventing one", async () => {
  const { ctx } = makeCtx({})
  const r = await retaskTask(ctx, "nope")
  assert.equal(r.ok, false)
})

// --- removeTask: hard-delete a task from the backlog entirely ---

test("removeTask deletes a draft outright — the file is gone, not moved", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.removed === true && r.data.from === "draft")
  assert.ok(!("/repo/docs/tasks/draft/t.md" in fs), "the file is removed")
  assert.ok(!Object.keys(fs).some((p) => p.includes("/t.md")), "and NOT relocated to another folder")
  assert.ok(log.some((c) => c.startsWith("rm ")), "the delete goes through rm")
})

test("removeTask works from any folder — a finished in-review task deletes too", async () => {
  const { ctx, fs } = makeCtx({ "in-review/t.md": task("Built", `${PLAN_HEADING}\n\n1. Step.`) })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.from === "in-review")
  assert.ok(!("/repo/docs/tasks/in-review/t.md" in fs))
})

test("removeTask refuses a task a live loop is driving — the file survives", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Building", `${PLAN_HEADING}\n\n1. Step.`) }, { driving: "t" })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /live loop/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs, "never deleted out from under a running loop")
})

test("removeTask refuses a claim-held task and names doctor fix", async () => {
  const { ctx, fs } = makeCtx({ "in-progress/t.md": task("Claimed"), "in-progress/.claims/t": "" })
  const r = await removeTask(ctx, "t")
  assert.equal(r.ok, false)
  assert.match(r.message, /claim marker/)
  assert.match(r.message, /doctor fix/)
  assert.ok("/repo/docs/tasks/in-progress/t.md" in fs, "untouched while a claim is held")
})

test("removeTask on a missing id is an idempotent success (rm -f semantics)", async () => {
  const { ctx } = makeCtx({})
  const r = await removeTask(ctx, "gone")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.alreadyDone === true)
})

test("approveTask moves a draft to queued and returns a structured result", async () => {
  const { ctx, log } = makeCtx({ "draft/t.md": task("Do it") })
  const r = await approveTask(ctx, "t")
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.data.approved === true)
  assert.match(r.message, /queued/)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("queued")))
})

test("approveTask on an already-queued task is an idempotent success", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": task("Do it") })
  const r = await approveTask(ctx, "t")
  assert.ok(r.ok && r.data.alreadyDone === true)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "no move on a retry")
})

test("approveTask on a missing task fails", async () => {
  const { ctx } = makeCtx({})
  const r = await approveTask(ctx, "nope")
  assert.equal(r.ok, false)
})

test("approveTask refuses a tracking epic — it stays in draft/, untouched", async () => {
  const { ctx, fs, log } = makeCtx({ "draft/epic.md": serializeTask({ title: "Big feature", type: "epic", body: "children in order…" }) })
  const r = await approveTask(ctx, "epic")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(r.message, /tracking epic/)
  assert.ok("/repo/docs/tasks/draft/epic.md" in fs, "the epic must stay in draft/")
  assert.ok(!log.some((c) => c.startsWith("mv ") || c.startsWith("printf")), "no move, no audit note on a refusal")
})

test("approveAny with an explicit epic id still reaches the tracking-epic refusal", async () => {
  // The epic skip is scoped to id-less resolution: naming an epic outright must
  // reach approveTask and get its specific refusal, not a generic "not found".
  const { ctx, fs } = makeCtx({ "draft/epic.md": serializeTask({ title: "Big feature", type: "epic", body: "children…" }) })
  const r = await approveAny(ctx, "epic")
  assert.equal(r.ok, false)
  assert.match(r.message, /tracking epic/)
  assert.ok("/repo/docs/tasks/draft/epic.md" in fs, "the epic must stay in draft/")
})

test("approvePlan advances a planned plan-review task to in-progress", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await approvePlan(ctx, "t")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("in-progress")))
})

test("approvePlan refuses a planless plan-review task with a warning, no move", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", "no plan here") })
  const r = await approvePlan(ctx, "t")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(!r.ok ? r.message : "", /no Implementation Plan/)
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("approvePlan on an already-in-progress task is idempotent", async () => {
  const { ctx } = makeCtx({ "in-progress/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await approvePlan(ctx, "t")
  assert.ok(r.ok && r.data.alreadyDone === true)
})

test("replanTask refuses a task a live loop is driving", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) }, { driving: "t" })
  const r = await replanTask(ctx, "t", "changed my mind")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.message : "", /live loop/)
  assert.ok(!log.some((c) => c.startsWith("mv ")))
})

test("replanTask sends a parked plan back to queued", async () => {
  const { ctx, log } = makeCtx({ "plan-review/t.md": task("Do it", `${PLAN_HEADING}\n\n1. step`) })
  const r = await replanTask(ctx, "t", "missed the cache")
  assert.ok(r.ok && r.data.requeued === true)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("queued")))
})

// `replan <id> <reason>` used to detect the leading id with an exact filename match,
// so a short-hash handle (`f7k3`) fell through into the reason and the SOLE plan-review
// task was replanned instead of the one the human named. rejectAny now resolves the
// short hash like `approve` does.
test("rejectAny replans the short-hash-named task, not the sole plan-review task", async () => {
  const { ctx, fs } = makeCtx({
    "in-progress/a1b2-do-thing.md": task("Do thing", `${PLAN_HEADING}\n\n1. step`),
    "plan-review/f7k3-fix-bar.md": task("Fix bar", `${PLAN_HEADING}\n\n1. step`),
  })
  const r = await rejectAny(ctx, "a1b2 wrong approach")
  assert.ok(r.ok && r.data.requeued === true)
  assert.ok("/repo/docs/tasks/queued/a1b2-do-thing.md" in fs, "the task addressed by its short hash moved to queued")
  assert.ok("/repo/docs/tasks/plan-review/f7k3-fix-bar.md" in fs, "the unrelated parked plan is untouched")
})

test("rejectAny surfaces an ambiguous short hash instead of folding it into the reason", async () => {
  const { ctx, fs } = makeCtx({
    "plan-review/f7k3-fix-bar.md": task("Fix bar", `${PLAN_HEADING}\n\n1. step`),
    "plan-review/f7k3-add-foo.md": task("Add foo", `${PLAN_HEADING}\n\n1. step`),
  })
  const r = await rejectAny(ctx, "f7k3 bad plan")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(!r.ok ? r.message : "", /Ambiguous id "f7k3"/)
  assert.ok(!("/repo/docs/tasks/queued/f7k3-fix-bar.md" in fs), "nothing moved on ambiguity")
})

test("shipTask moves an in-review task to completed (no branch → no PR)", async () => {
  const { ctx, fs } = makeCtx({ "in-review/t.md": task("Do it") })
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok && typeof r.data.completed === "string")
  assert.ok(!("pr" in (r.ok ? r.data : {})), "no PR attempted without a feature branch")
  assert.ok("/repo/docs/tasks/completed/t.md" in fs)
})

// Ship is the ONLY point that removes a task's worktree: it is kept across every
// earlier run so retries and recoveries build on prior iterations.
test("shipTask releases the task's worktree once the task is completed", async () => {
  const wt = "/repo/.workflow-worktrees/t"
  const { ctx, log } = makeCtx(
    { "in-review/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("worktree list")) return { exitCode: 0, stdout: `worktree ${wt}\nHEAD abc\nbranch refs/heads/feature/t\n` }
        if (cmd.includes("is-inside-work-tree")) return { exitCode: 0, stdout: "true" }
        if (cmd.includes("worktree remove")) return { exitCode: 0, stdout: "" }
        return undefined // everything else keeps the default "no actor, no branch"
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(log.some((c) => c.includes(`worktree remove ${wt}`)), log.join(" | "))
})

// --- id resolution: approve by short-hash prefix, ambiguity, legacy back-compat ---

test("approveTask resolves a draft by its short-hash prefix", async () => {
  const { ctx, fs } = makeCtx({ "draft/f7k3-flight-map.md": task("Flight Map") })
  const r = await approveTask(ctx, "f7k3")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/queued/f7k3-flight-map.md" in fs, "moved by the resolved full id")
})

test("approveTask on an ambiguous prefix refuses with a warning (never guesses)", async () => {
  const { ctx, fs } = makeCtx({ "draft/f7k3-flight-map.md": task("Flight Map"), "draft/fa2b-fee-calc.md": task("Fee Calc") })
  const r = await approveTask(ctx, "f")
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.variant === "warning")
  assert.match(r.message, /[Aa]mbiguous/)
  assert.match(r.message, /f7k3-flight-map/)
  assert.ok(!("/repo/docs/tasks/queued/f7k3-flight-map.md" in fs), "nothing moved on ambiguity")
})

test("approveTask still resolves a legacy slug id exactly (back-compat)", async () => {
  const { ctx, fs } = makeCtx({ "draft/add-rate-limiting.md": task("Add rate limiting") })
  const r = await approveTask(ctx, "add-rate-limiting")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/queued/add-rate-limiting.md" in fs)
})

test("approvePlan resolves a plan-review task by its short-hash prefix", async () => {
  const { ctx, fs } = makeCtx({ "plan-review/a1b2-do-bar.md": `${task("Do bar")}\n\n${PLAN_HEADING}\n\nStep 1.` })
  const r = await approvePlan(ctx, "a1b2")
  assert.ok(r.ok && r.data.approved === true)
  assert.ok("/repo/docs/tasks/in-progress/a1b2-do-bar.md" in fs)
})

// A task file whose frontmatter can't be parsed (schema failure, unrescuable
// YAML) used to surface as "no task found" — findByIdIn swallows the parse
// error — sending the human hunting for a file that is right there. The gates
// now diagnose the unparseable file instead.
test("approveTask on an unparseable draft reports the parse problem, not 'no task found'", async () => {
  // Valid YAML, invalid schema (no title) — the parse-repair retry can't rescue this.
  const broken = "---\npriority: 1\n---\nSome body."
  const { ctx, fs } = makeCtx({ "draft/x9y8-broken-task.md": broken })
  const r = await approveTask(ctx, "x9y8-broken-task")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.message : "", /exists but can't be parsed/)
  assert.match(!r.ok ? r.message : "", /draft\/x9y8-broken-task\.md/)
  assert.match(!r.ok ? r.message : "", /title/)
  assert.ok("/repo/docs/tasks/draft/x9y8-broken-task.md" in fs, "nothing moved")
})

// --- ship retry after a crash between the completed/ move and shipPr ---
// A crash in that window leaves the task completed with the branch unpushed and
// no PR; the retry must re-attempt the (idempotent) shipPr, not report success
// and delete the worktree with the PR silently absent.

test("shipTask retry on an already-completed task re-attempts the PR when none was recorded", async () => {
  const { ctx, fs, log } = makeCtx(
    { "completed/t.md": task("Do it") },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" } // feature/t exists
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" } // push succeeds
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(
    log.some((c) => c.includes("push -u origin feature/t")),
    "the retry must push the unshipped branch",
  )
  // gh is stubbed to no-op here, so the PR isn't actually opened — the point is
  // the attempt is recorded (a "PR not opened" note appended), not silently skipped.
  assert.ok(log.some((c) => c.includes("PR not opened")), "the PR attempt must be audited on the completed task")
  assert.ok("/repo/docs/tasks/completed/t.md" in fs, "the task stays completed")
})

test("shipTask retry does nothing when the completed task already recorded a PR", async () => {
  const withPr = `${task("Do it")}\n\n> PR opened — https://example.com/pr/1 _(2026-01-01)_`
  const { ctx, log } = makeCtx(
    { "completed/t.md": withPr },
    {
      git: (cmd) => {
        if (cmd.includes("rev-parse --verify")) return { exitCode: 0, stdout: "" }
        if (cmd.includes("push")) return { exitCode: 0, stdout: "" }
        return undefined
      },
    },
  )
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok)
  assert.ok(!log.some((c) => c.includes("push -u origin")), "no re-push once a PR is on record")
})
