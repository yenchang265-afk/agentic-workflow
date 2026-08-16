import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { registerValidateHook } from "../manifest/registry.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import type { Action, WorkflowState } from "./state.js"
import type { Outcome } from "./metrics.js"
import { runTerminal, type TerminalCtx } from "./terminal.js"

/**
 * The shared terminal handler, driven against a tiny in-memory backlog (the same
 * fake-shell as gate.test: a file map with `cat`/`mv`; git commands report failure
 * so no real isolation runs). The host commit/metrics strategies are injected as
 * spies, so the tests assert the CONTROL FLOW core owns: the plan-landed veto, the
 * task move, the `isolated`-gating that keeps a never-isolated stage off the main
 * tree (the B5 fix), and which port fires when.
 */
const makeCtx = (
  files: Record<string, string>,
  state: WorkflowState,
  opts: { validate?: string; manifest?: LoadedManifest; config?: Partial<TerminalCtx["config"]> } = {},
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
      // `-n` is modelled, not skipped — see the same note in gate.test.
      const noClobber = parts.includes("-n")
      const [src, dest] = parts.slice(1).filter((p) => !p.startsWith("-"))
      if (noClobber && dest! in fs) out = { exitCode: 0, stdout: "" } // successful no-op; source survives
      else if (src! in fs) {
        fs[dest!] = fs[src!]!
        delete fs[src!]
      } else out = { exitCode: 1, stdout: "" }
    } else if (parts[0] === "git") out = { exitCode: 1, stdout: "" } // no actor, no branch → no isolation
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
  const metrics: { outcome: Outcome; detail: string }[] = []
  const commits: string[] = []
  const checkpoints: string[] = []
  const ops: string[] = [] // interleaved port order — asserts checkpoint-before-backlog-commit
  const manifest =
    opts.manifest ??
    ({ manifest: { hooks: { validateBeforeTransition: opts.validate ? { [state.stage]: opts.validate } : {} } } } as unknown as LoadedManifest)
  const ctx: TerminalCtx = {
    $,
    log: () => {},
    directory: "/repo",
    // ignoreBacklog defaults to true; these tests assert the commit STRATEGY
    // itself (ordering vs. checkpoint/teardown), so opt back into committing.
    config: { ...DEFAULT_CONFIG, ignoreBacklog: false, ...opts.config },
    state,
    manifest,
    actor: "tester",
    commitBacklog: async (m) => {
      commits.push(m)
      ops.push(`commit:${m}`)
    },
    checkpoint: async (m) => {
      checkpoints.push(m)
      ops.push(`checkpoint:${m}`)
    },
    writeMetrics: async (outcome, detail) => void metrics.push({ outcome, detail }),
  }
  return { ctx, fs, log, metrics, commits, checkpoints, ops }
}

const taskRef = (id: string, status: string) => ({ id, path: `/repo/docs/tasks/${status}/${id}.md`, acceptance: [] })
const body = (withPlan: boolean) => serializeTask({ title: "Do it", body: withPlan ? `${PLAN_HEADING}\n\n1. step` : "no plan yet" })

const park: Extract<Action, { kind: "park" }> = { kind: "park", message: "Plan complete." }
const done: Extract<Action, { kind: "done" }> = { kind: "done", message: "Loop complete — review passed." }
const stop: Extract<Action, { kind: "stop" }> = { kind: "stop", message: "Loop stopped at build." }

const planState = (): WorkflowState => ({ goal: "Do it", stage: "plan", iteration: 0, artifacts: {}, task: taskRef("t", "queued") })

test("park moves a planned queued task to plan-review and reports the path", async () => {
  const { ctx, log, metrics, commits } = makeCtx({ "queued/t.md": body(true) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  assert.ok(report.kind === "park" && report.taskId === "t")
  assert.ok(report.kind === "park" && report.path.includes("plan-review"))
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("plan-review")))
  assert.deepEqual(commits.length, 1)
  assert.deepEqual(metrics, [{ outcome: "done", detail: "plan parked for review" }])
})

test("notifyCommand fires on park with the event in env vars, after the move", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState(), { config: { notifyCommand: "notify-send test" } })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  const notify = log.find((c) => c.startsWith("env AW_EVENT=park"))
  assert.ok(notify, `the notifier must run: ${log.join(" | ")}`)
  assert.match(notify, /AW_KIND=engineering/)
  assert.match(notify, /AW_TASK=t/)
  assert.match(notify, /AW_MESSAGE=/)
  assert.match(notify, /sh -c notify-send test$/)
  assert.ok(log.indexOf(notify) > log.findIndex((c) => c.startsWith("mv ") && c.includes("plan-review")), "announce only after the move landed")
})

test("notifyEvents filters which terminal events fire the notifier", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState(), {
    config: { notifyCommand: "notify-send test", notifyEvents: ["done", "stop"] },
  })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  assert.ok(!log.some((c) => c.startsWith("env AW_EVENT=")), "park is not in the configured event set")
})

test("no notifyCommand means no notifier invocation at all", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState())
  await runTerminal(ctx, park)
  assert.ok(!log.some((c) => c.startsWith("env AW_EVENT=")))
})

test("a park veto still notifies as an error event, and a failing notifier changes nothing", async () => {
  // The no-plan park degrades to an error report; the notifier hears about it
  // (that is the "needs attention" case), and its own failure only warns.
  const warned: string[] = []
  const { ctx, log } = makeCtx({ "queued/t.md": body(false) }, planState(), { config: { notifyCommand: "exit 1" } })
  const report = await runTerminal({ ...ctx, log: (_lvl, msg) => void warned.push(msg) }, park)
  assert.equal(report.kind, "error", "the notifier must not change the outcome")
  assert.ok(log.some((c) => c.startsWith("env AW_EVENT=error")), "the veto is announced as an error event")
})

test("park releases the claim and reports an error when the move throws", async () => {
  // runDone has always wrapped its note→move→commit in try/catch and released
  // the claim on failure; runPark ran the identical sequence unguarded. A
  // duplicate destination (moveTask's `test -e` refusal) therefore escaped
  // runTerminal AFTER the "Plan written — parked" note was already on disk
  // asserting a park that never happened — and the held marker then blocked every
  // gate verb (replan/abandon/remove all refuse a claim) until the stale sweep.
  const { ctx, log, metrics } = makeCtx({ "queued/t.md": body(true), "plan-review/t.md": body(true) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error", "the throw must not escape runTerminal")
  assert.match(report.kind === "error" ? report.message : "", /park to plan-review\/ failed/)
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes(".claims/t")),
    "the queued/ claim marker is released rather than wedged",
  )
  assert.equal(metrics[0]?.outcome, "error", "and the run is recorded as failed, not done")
})

test("park with no plan on disk fails and leaves the task in queued", async () => {
  const { ctx, log, metrics } = makeCtx({ "queued/t.md": body(false) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /PLAN failed/)
  assert.ok(!log.some((c) => c.startsWith("mv ") && c.includes("plan-review")), "no move to plan-review")
  assert.deepEqual(metrics, [{ outcome: "error", detail: "the PLAN stage wrote no ## Implementation Plan" }])
})

test("park with the task gone from queued/ still releases the claim-time marker, no append", async () => {
  // The mirror of "stop mid-plan with the task gone …" below, for the park path.
  // runPark nested its release under `if (fresh)`, so when the task left queued/
  // mid-plan (a hub replan/abandon, a hand edit, a crash-recovered rescue) the
  // drive ended with the marker still held — and a held marker asserts a LIVE
  // loop, so every gate verb refused it and neither `plan <id>` nor the claim
  // walk could re-acquire it until the stale sweep fired ~75min later. Every way
  // a drive ends must release the marker.
  const { ctx, log, metrics } = makeCtx({}, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /left queued\/ mid-plan/)
  assert.ok(!log.some((c) => c.includes(">>")), "no append to a missing task")
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes("queued/.claims/t")),
    `claim marker released via the claim-time ref: ${log.join(" | ")}`,
  )
  assert.equal(metrics[0]?.outcome, "error")
})

// A manifest whose plan stage opts into the plan contract (only the fields
// runPark reads — the tolerant stage lookup must not require a full manifest).
const contractManifest = (stage: string): LoadedManifest =>
  ({ manifest: { hooks: { validateBeforeTransition: {} }, stages: [{ name: stage, planContract: true }] } }) as unknown as LoadedManifest

test("park refuses a contract-flagged plan with no ### Verification subsection, claim released, task stays queued", async () => {
  const { ctx, fs, log, metrics } = makeCtx({ "queued/t.md": body(true) }, planState(), { manifest: contractManifest("plan") })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /no ### Verification subsection/)
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "the task stays in queued/")
  assert.ok(!log.some((c) => c.startsWith("mv ") && c.includes("plan-review")), "no move to plan-review")
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes(".claims/t")),
    "the refusal releases the claim — every way a drive ends must",
  )
  assert.equal(metrics[0]?.outcome, "error")
})

// A manifest whose check stage discovers its commands (only the fields the
// park-time preview reads); no planContract, so the preview is tested apart
// from the contract veto.
const discoveryManifest = (): LoadedManifest =>
  ({
    manifest: {
      kind: "engineering",
      hooks: { validateBeforeTransition: {} },
      stages: [
        {
          name: "verify",
          kind: "check",
          discoverChecks: true,
          checks: [],
          bashAllowlist: ["npm test*"],
          platformAllowlist: {},
        },
      ],
    },
  }) as unknown as LoadedManifest

const planWithFence = (checks: string): string =>
  serializeTask({ title: "Do it", body: `${PLAN_HEADING}\n\n1. step\n\n### Verification\n\n\`\`\`agentic-checks\n${checks}\n\`\`\`` })

test("park forecasts the discovered checks on the park note and message", async () => {
  // The refusals used to surface only at VERIFY fire time as a log line —
  // one gate too late for the human who is about to approve the plan.
  const files = { "queued/t.md": planWithFence('[{ "name": "tests", "command": "npm test" }]') }
  const { ctx, log } = makeCtx(files, planState(), { manifest: discoveryManifest() })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  assert.ok(report.kind === "park" && report.message.includes("discovered checks: 1 admitted for VERIFY"), `message carries the forecast: ${report.kind === "park" ? report.message : ""}`)
  assert.ok(log.some((c) => c.includes("Plan written — parked for plan review — discovered checks: 1 admitted for VERIFY")), "the note carries it durably")
})

test("park warns loudly when the whole fence is inadmissible — NONE will run", async () => {
  const files = { "queued/t.md": planWithFence('[{ "name": "lint", "command": "make lint" }]') }
  const { ctx } = makeCtx(files, planState(), { manifest: discoveryManifest() })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park", "forecast only — design 18 forbids a park-time veto")
  assert.ok(report.kind === "park" && report.message.includes("NONE admitted for VERIFY"))
  assert.ok(report.kind === "park" && report.message.includes("not on this stage's bash allowlist"), "the reason is named, not just the count")
})

test("park on a fence-less plan says the consumer will run no machine checks", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState(), { manifest: discoveryManifest() })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  assert.ok(report.kind === "park" && report.message.includes("no agentic-checks block: VERIFY will run no machine-run checks"))
  assert.ok(log.some((c) => c.includes("no agentic-checks block")))
})

test("park under a non-discovering kind writes the note exactly as before — no forecast", async () => {
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
  assert.ok(report.kind === "park" && report.message === park.message, "message untouched")
  assert.ok(log.some((c) => c.includes("Plan written — parked for plan review [")), "note untouched (stamp follows the marker directly)")
  assert.ok(!log.some((c) => c.includes("agentic-checks") && c.includes(">>")), "no forecast text")
})

test("park accepts a contract-flagged plan whose Verification heading varies in case and suffix", async () => {
  const planned = serializeTask({ title: "Do it", body: `${PLAN_HEADING}\n\n1. step\n\n### verification & testing\n\n- npm test` })
  const { ctx, log } = makeCtx({ "queued/t.md": planned }, planState(), { manifest: contractManifest("plan") })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park", "tolerant heading match — strictness here livelocks the queue")
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("plan-review")))
})

test("a contract refusal writes the canonical rejection note the next PLAN pass can parse", async () => {
  // The refusal reason must reach the retry's {{#replan}} section, which means
  // the note must be the exact shape `extractReplanReason` parses — the old
  // free-form "PLAN stage failed" note matched nothing and the retry
  // re-planned blind, repeating the same contract mistake every tick.
  const { ctx, log } = makeCtx({ "queued/t.md": body(true) }, planState(), { manifest: contractManifest("plan") })
  await runTerminal(ctx, park)
  assert.ok(
    log.some((c) => c.includes("Plan rejected [contract] — sent back to queued for re-planning — the plan has no ### Verification subsection")),
    `refusal note carries contractRejectedNote's parseable, tagged shape: ${log.filter((c) => c.includes(">>")).join(" | ")}`,
  )
})

test("the third unaddressed CONTRACT refusal returns the task to draft/ for human triage", async () => {
  // Two stamped, unaddressed, TAGGED rejection notes already on the body + the
  // one this refusal appends = 3 → the park gate stops re-queueing (the queued
  // pool re-claims instantly, so each refusal otherwise burns a PLAN run per
  // poll tick forever) and hands the task back to a human.
  const stamped = (text: string) => `> ${text} [2026-08-01T00:00:00.000Z by tester]`
  const planned = serializeTask({
    title: "Do it",
    body: `${PLAN_HEADING}\n\n1. step\n\n${stamped("Plan rejected [contract] — sent back to queued for re-planning — refusal one")}\n${stamped("Plan rejected [contract] — sent back to queued for re-planning — refusal two")}`,
  })
  const { ctx, fs, metrics } = makeCtx({ "queued/t.md": planned }, planState(), { manifest: contractManifest("plan") })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /Returned to .*draft/)
  assert.ok("/repo/docs/tasks/draft/t.md" in fs, "the task landed in draft/")
  assert.ok(!("/repo/docs/tasks/queued/t.md" in fs), "…and left queued/ — no more claim walks")
  assert.match(metrics[0]?.detail ?? "", /returned to draft after 3 refusals/)
})

test("two human replans plus one contract miss is NOT three contract strikes", async () => {
  // A human's `replan` writes the SAME base note shape but untagged
  // (`planRejectedNote`, no ` [contract]`) — deliberate feedback, not the
  // planner looping on a mechanical mistake. Two of those plus this refusal
  // (the first TAGGED one) must be strike ONE, not strike three, or a human
  // rejecting a plan twice for substantive reasons silently dumps the task to
  // draft/ on the very next mechanical contract miss.
  const stamped = (text: string) => `> ${text} [2026-08-01T00:00:00.000Z by tester]`
  const planned = serializeTask({
    title: "Do it",
    body: `${PLAN_HEADING}\n\n1. step\n\n${stamped("Plan rejected — sent back to queued for re-planning — I want a different approach")}\n${stamped("Plan rejected — sent back to queued for re-planning — still not it")}`,
  })
  const { ctx, fs } = makeCtx({ "queued/t.md": planned }, planState(), { manifest: contractManifest("plan") })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "strike one: still queued, not drafted")
  assert.ok(!("/repo/docs/tasks/draft/t.md" in fs), "two human replans never count toward the contract strike limit")
})

test("a prior successful park retires old rejections — the strike counter never reaches across cycles", async () => {
  // Same two old rejections, but a `Plan written` note after them: they were
  // addressed, so this refusal is strike ONE and the task stays queued.
  const stamped = (text: string) => `> ${text} [2026-08-01T00:00:00.000Z by tester]`
  const planned = serializeTask({
    title: "Do it",
    body: `${PLAN_HEADING}\n\n1. step\n\n${stamped("Plan rejected [contract] — sent back to queued for re-planning — refusal one")}\n${stamped("Plan rejected [contract] — sent back to queued for re-planning — refusal two")}\n${stamped("Plan written — parked for plan review")}`,
  })
  const { ctx, fs } = makeCtx({ "queued/t.md": planned }, planState(), { manifest: contractManifest("plan") })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.ok("/repo/docs/tasks/queued/t.md" in fs, "strike one: still queued, not drafted")
})

test("park without the contract flag parks a Verification-less plan exactly as before", async () => {
  // The default fake manifest declares no stages at all — the tolerant lookup
  // must read that as "no contract", not throw.
  const { ctx } = makeCtx({ "queued/t.md": body(true) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park")
})

test("park vetoed by a registered validateBeforeTransition hook errors, no move", async () => {
  registerValidateHook("test.veto", () => "the tree is dirty")
  const { ctx, log, metrics } = makeCtx({ "queued/t.md": body(true) }, planState(), { validate: "test.veto" })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /vetoed.*the tree is dirty/)
  assert.ok(!log.some((c) => c.startsWith("mv ")), "vetoed park never moves")
  assert.deepEqual(metrics, [{ outcome: "error", detail: "the tree is dirty" }])
})

test("park vetoed with the task gone from queued/ still releases the claim-time marker", async () => {
  // The veto arm is a drive-end path like every other: nesting its release
  // under the `if (held)` lookup left the queued/.claims/<id> marker held
  // whenever the task had left queued/ mid-plan — the exact wedge the
  // not-parking arm below documents and guards against.
  registerValidateHook("test.veto-gone", () => "the tree is dirty")
  const { ctx, log } = makeCtx({}, planState(), { validate: "test.veto-gone" })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes("queued/.claims/t")),
    `claim marker released via the claim-time ref: ${log.join(" | ")}`,
  )
})

test("park on a task-less loop reports park-free with no metrics", async () => {
  const { ctx, metrics } = makeCtx({}, { goal: "free text", stage: "plan", iteration: 0, artifacts: {} })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park-free")
  assert.equal(metrics.length, 0)
})

test("done parks the task in in-review and commits the backlog when not isolated", async () => {
  const state: WorkflowState = { goal: "Do it", stage: "review", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log, metrics, commits, checkpoints } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, done)
  assert.ok(report.kind === "done" && report.moved === true)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("in-review")))
  assert.equal(commits.length, 1, "not isolated → backlog committed explicitly")
  assert.equal(checkpoints.length, 0, "not isolated → no checkpoint")
  assert.deepEqual(metrics, [{ outcome: "done", detail: "review passed" }])
})

// --- the done note's branch/base clauses ---
//
// The note is the ONLY thing that survives to the ship gate: the snapshot is
// cleared by runDone itself, and shipTask runs later from a fresh process.

/** The done note as it reached the file, recovered from the appendNote write. */
const doneNoteFrom = (log: string[]): string => log.find((c) => c.includes("Loop done — review passed")) ?? ""

test("the done note records the branch AND the base the run was cut from", async () => {
  const state: WorkflowState = {
    goal: "Do it",
    stage: "review",
    iteration: 0,
    artifacts: {},
    task: taskRef("t", "in-progress"),
    git: { base: "release/2.4", branch: "feature/t" },
  }
  const { ctx, log } = makeCtx({ "in-progress/t.md": body(true) }, state)
  await runTerminal(ctx, done)
  const note = doneNoteFrom(log)
  assert.match(note, /on branch feature\/t, base release\/2.4, awaiting human diff review/)
})

test("current-branch mode records NO base, because there the base is a commit sha", async () => {
  // `gh pr create --base <sha>` is not a thing. Recording it would turn today's
  // wrong-but-working platform default into a hard ship failure.
  const state: WorkflowState = {
    goal: "Do it",
    stage: "review",
    iteration: 0,
    artifacts: {},
    task: taskRef("t", "in-progress"),
    git: { base: "9f1c0de1c0de1c0de1c0de1c0de1c0de1c0de1c0", branch: "my-work", onCurrentBranch: true },
  }
  const { ctx, log } = makeCtx({ "in-progress/t.md": body(true) }, state)
  await runTerminal(ctx, done)
  const note = doneNoteFrom(log)
  assert.match(note, /on branch my-work, awaiting human diff review/)
  assert.doesNotMatch(note, /base /, "a sha must never be offered to the ship gate as a base branch")
})

test("a run with no git state writes the note it always wrote", async () => {
  const state: WorkflowState = { goal: "Do it", stage: "review", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log } = makeCtx({ "in-progress/t.md": body(true) }, state)
  await runTerminal(ctx, done)
  const note = doneNoteFrom(log)
  assert.match(note, /Loop done — review passed, awaiting human diff review/)
  assert.doesNotMatch(note, /on branch/)
})

test("done with a blocked move reports a retryable stop, keeps the snapshot, and releases the claim", async () => {
  const state: WorkflowState = { goal: "Do it", stage: "review", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  // A duplicate already sits at the destination — moveTask refuses to clobber
  // it. The loop must NOT report done: the task is still in in-progress/.
  const { ctx, log, metrics } = makeCtx({ "in-progress/t.md": body(true), "in-review/t.md": "dup" }, state)
  const report = await runTerminal(ctx, done)
  assert.equal(report.kind, "stop")
  assert.ok(report.kind === "stop" && report.retryable === true, "environment fault, not a failed attempt")
  assert.match(report.kind === "stop" ? report.message : "", /review passed/i)
  assert.deepEqual(
    metrics.map((m) => m.outcome),
    ["error"],
    "metrics must not record a clean done",
  )
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes(".claims/t")),
    "claim marker released so the task is not wedged",
  )
  assert.ok(!log.some((c) => c.includes("t.state.json")), "resume snapshot kept for recover")
})

test("done on an isolated shared-tree loop checkpoints BEFORE the backlog move + commit", async () => {
  // The checkpoint's `git add -A` would otherwise sweep the backlog write into
  // the feature commit instead of leaving it its own. (Teardown no longer moves
  // the tree off the work branch, so there is no checkout to order against —
  // terminal.git.test.ts covers the branch-level facts against real git.)
  const state: WorkflowState = {
    goal: "Do it",
    stage: "review",
    iteration: 0,
    artifacts: {},
    task: taskRef("t", "in-progress"),
    git: { base: "main", branch: "feature/t" }, // shared-tree: no worktree
    isolated: true,
  }
  const { ctx, log, metrics, commits, checkpoints, ops } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, done)
  assert.ok(report.kind === "done" && report.moved === true)
  assert.equal(checkpoints.length, 1, "isolated → checkpoint runs")
  assert.equal(commits.length, 1, "the backlog move gets its own commit on the human branch")
  assert.ok(ops[0]!.startsWith("checkpoint:") && ops[1]!.startsWith("commit:"), `checkpoint must precede the backlog commit: ${ops.join(" | ")}`)
  // Teardown must not switch the tree — the human's next act is this branch.
  assert.ok(!log.some((c) => c.startsWith("git ") && c.includes("checkout")), log.join(" | "))
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("in-review")), log.join(" | "))
  assert.deepEqual(metrics, [{ outcome: "done", detail: "review passed" }])
})

test("stop on an isolated shared-tree loop checkpoints and tears down BEFORE the note + backlog commit", async () => {
  const state: WorkflowState = {
    goal: "Do it",
    stage: "build",
    iteration: 0,
    artifacts: {},
    task: taskRef("t", "in-progress"),
    git: { base: "main", branch: "feature/t" },
    isolated: true,
  }
  const { ctx, commits, checkpoints, ops } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.equal(checkpoints.length, 1)
  assert.equal(commits.length, 1, "the stop note gets its own commit on the human branch")
  assert.ok(ops[0]!.startsWith("checkpoint:") && ops[1]!.startsWith("commit:"), `checkpoint must precede the backlog commit: ${ops.join(" | ")}`)
})

test("stop annotates the task and leaves it in place (no move)", async () => {
  const state: WorkflowState = { goal: "Do it", stage: "build", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log, metrics, commits } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.ok(!log.some((c) => c.startsWith("mv ")), "a stopped task stays where it is")
  assert.equal(commits.length, 1)
  assert.deepEqual(metrics, [{ outcome: "stopped", detail: "Loop stopped at build." }])
})

test("a non-transient stop with attempts records the digest note; a retryable one does not", async () => {
  // The snapshot holding `state.attempts` is cleared by the stop itself, and
  // the replan the cap message recommends reads only the task file — without
  // this note the next PLAN pass re-plans blind to what every attempt failed on.
  const attempts = [
    { stage: "verify", iteration: 0, verdict: "FAIL" as const, reason: "2 criteria unmet" },
    { stage: "review", iteration: 1, verdict: "FAIL" as const, reason: "unhandled error path" },
  ]
  const state: WorkflowState = { goal: "Do it", stage: "verify", iteration: 2, artifacts: {}, task: taskRef("t", "in-progress"), attempts }
  const { ctx, log } = makeCtx({ "in-progress/t.md": body(true) }, state)
  await runTerminal(ctx, stop)
  assert.ok(
    log.some((c) => c.includes("Run stopped — attempts: iteration 1 VERIFY FAIL: 2 criteria unmet; iteration 2 REVIEW FAIL: unhandled error path")),
    `the digest note lands in the exact stopContextNote shape: ${log.filter((c) => c.includes("Run stopped")).join(" | ")}`,
  )

  // A flaky-environment stop's ledger is noise the next run does not need.
  const { ctx: ctx2, log: log2 } = makeCtx({ "in-progress/t.md": body(true) }, state)
  await runTerminal(ctx2, { kind: "stop", message: "Loop stopped at build.", retryable: true })
  assert.ok(!log2.some((c) => c.includes("Run stopped — attempts:")), "no digest on a retryable stop")
})

test("stop from a build/check stage releases the in-progress claim marker", async () => {
  // The wedge: a cap-tripped stop (verify/review FAILed maxIterations times)
  // kept the marker held, and every escape the cap message offers — replan,
  // abandon, remove — refuses a held claim, while the orphan sweep skips a
  // body carrying CLAIMED/BUILD notes. Release on stop is what frees the task
  // for the very `replan <id>` the stop message instructs.
  const state: WorkflowState = { goal: "Do it", stage: "verify", iteration: 2, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes("in-progress/.claims/t")),
    `in-progress claim marker must be released: ${log.join(" | ")}`,
  )
})

test("stop with the task gone from in-progress/ skips the note and creates no ghost file", async () => {
  // The resurrection regression: appendNote's `>>` creates the file if absent, so a
  // stop after a human moved/deleted the task must never write to the stale path.
  const state: WorkflowState = { goal: "Do it", stage: "build", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log, metrics, commits, fs } = makeCtx({}, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.ok(!log.some((c) => c.includes(">>")), `no append to a missing task: ${log.join(" | ")}`)
  assert.equal(commits.length, 0, "nothing written → nothing to commit")
  assert.ok(!("/repo/docs/tasks/in-progress/t.md" in fs), "no ghost file resurrected")
  assert.deepEqual(metrics, [{ outcome: "stopped", detail: "Loop stopped at build." }])
})

test("stop appends to the re-resolved path, not the stale claim-time path", async () => {
  // Claim-time ref points at queued/, but the file has since moved to in-progress/ —
  // the note must land on the real current path.
  const state: WorkflowState = { goal: "Do it", stage: "build", iteration: 0, artifacts: {}, task: taskRef("t", "queued") }
  const { ctx, log, commits } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  const append = log.find((c) => c.includes(">>"))
  assert.ok(append?.includes("in-progress/t.md"), `append must target the re-resolved path: ${append}`)
  assert.equal(commits.length, 1)
})

test("stop mid-plan releases the queued claim marker and appends in queued/", async () => {
  const { ctx, log, commits } = makeCtx({ "queued/t.md": body(false) }, planState())
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  const append = log.find((c) => c.includes(">>"))
  assert.ok(append?.includes("queued/t.md"), `append must target queued/: ${append}`)
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes("queued/.claims/t")),
    `queued claim marker must be released: ${log.join(" | ")}`,
  )
  assert.equal(commits.length, 1)
})

test("stop mid-plan with the task gone still releases the claim-time marker, no append", async () => {
  const { ctx, log, commits } = makeCtx({}, planState())
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.ok(!log.some((c) => c.includes(">>")), "no append to a missing task")
  assert.ok(
    log.some((c) => c.startsWith("rmdir ") && c.includes("queued/.claims/t")),
    `claim marker released via the claim-time ref: ${log.join(" | ")}`,
  )
  assert.equal(commits.length, 0)
})

test("a source-pre-set git that never isolated leaves the main tree untouched (B5)", async () => {
  // pr-sitter triage → done "nothing actionable": git names the branch to isolate ONTO
  // but `isolated` is false, so no checkpoint/teardown may touch the human's main tree.
  const state: WorkflowState = {
    goal: "Sit on PR",
    stage: "triage",
    iteration: 0,
    artifacts: {},
    git: { base: "main", branch: "pr-head" }, // pre-set, NOT isolated
  }
  const { ctx, log, checkpoints } = makeCtx({}, state)
  const report = await runTerminal(ctx, done)
  assert.equal(report.kind, "done")
  assert.equal(checkpoints.length, 0, "never isolated → no checkpoint commit")
  const touched = log.some((c) => c.startsWith("git ") && (c.includes(" add -A") || c.includes(" commit") || c.includes(" checkout")))
  assert.equal(touched, false, `main tree was mutated: ${log.filter((c) => c.startsWith("git ")).join(" | ")}`)
})

// --- current-branch mode at drive end: the lock decides who may touch the tree ---

const OWNER_FILE = "runs/.current-branch/owner.json"

const currentBranchState = (isolated: boolean): WorkflowState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: taskRef("t", "in-progress"),
  git: { base: "abc123", branch: "work", onCurrentBranch: true },
  ...(isolated ? { isolated: true } : {}),
})

test("current-branch stop: a rival now holding the lock means no checkpoint and no release", async () => {
  // This run's lock went stale mid-phase, was swept, and "zz" re-acquired it.
  // Checkpointing would `git add -A` the rival's in-flight work as ours, and a
  // blind release would free the rival's live lock — skip both.
  const { ctx, log, checkpoints } = makeCtx(
    { "in-progress/t.md": body(true), [OWNER_FILE]: JSON.stringify({ id: "zz", branch: "work" }) },
    currentBranchState(true),
  )
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.equal(checkpoints.length, 0, "the rival's tree must not be checkpointed")
  const released = log.some((c) => c.startsWith("rm ") && c.includes(".current-branch/owner.json"))
  assert.equal(released, false, "the rival's lock must not be released")
})

test("current-branch stop: a degraded run (isolated false) still returns its own lock", async () => {
  // The tree moved mid-run, isolation degraded — no checkpoint. But the lock
  // from the last good boundary is still this run's, and leaving it wedges the
  // tree for every later run until the stale sweep.
  const { ctx, log, checkpoints } = makeCtx({ "in-progress/t.md": body(true) }, currentBranchState(false))
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.equal(checkpoints.length, 0, "a degraded run must not checkpoint the tree it lost")
  const released = log.some((c) => c.startsWith("rm ") && c.includes(".current-branch/owner.json"))
  assert.equal(released, true, "the still-owned lock must be returned at drive end")
})

test("current-branch stop: the rightful owner checkpoints and releases as before", async () => {
  const { ctx, log, checkpoints } = makeCtx(
    { "in-progress/t.md": body(true), [OWNER_FILE]: JSON.stringify({ id: "t", branch: "work" }) },
    currentBranchState(true),
  )
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.equal(checkpoints.length, 1)
  const released = log.some((c) => c.startsWith("rm ") && c.includes(".current-branch/owner.json"))
  assert.equal(released, true)
})
