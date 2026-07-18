import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { registerValidateHook } from "../manifest/registry.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import type { Action, LoopState } from "./state.js"
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
  state: LoopState,
  opts: { validate?: string; manifest?: LoadedManifest } = {},
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
    config: DEFAULT_CONFIG,
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

const planState = (): LoopState => ({ goal: "Do it", stage: "plan", iteration: 0, artifacts: {}, task: taskRef("t", "queued") })

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

test("park with no plan on disk fails and leaves the task in queued", async () => {
  const { ctx, log, metrics } = makeCtx({ "queued/t.md": body(false) }, planState())
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "error")
  assert.match(report.kind === "error" ? report.message : "", /PLAN failed/)
  assert.ok(!log.some((c) => c.startsWith("mv ") && c.includes("plan-review")), "no move to plan-review")
  assert.deepEqual(metrics, [{ outcome: "error", detail: "the PLAN stage wrote no ## Implementation Plan" }])
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

test("park on a task-less loop reports park-free with no metrics", async () => {
  const { ctx, metrics } = makeCtx({}, { goal: "free text", stage: "plan", iteration: 0, artifacts: {} })
  const report = await runTerminal(ctx, park)
  assert.equal(report.kind, "park-free")
  assert.equal(metrics.length, 0)
})

test("done parks the task in in-review and commits the backlog when not isolated", async () => {
  const state: LoopState = { goal: "Do it", stage: "review", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log, metrics, commits, checkpoints } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, done)
  assert.ok(report.kind === "done" && report.moved === true)
  assert.ok(log.some((c) => c.startsWith("mv ") && c.includes("in-review")))
  assert.equal(commits.length, 1, "not isolated → backlog committed explicitly")
  assert.equal(checkpoints.length, 0, "not isolated → no checkpoint")
  assert.deepEqual(metrics, [{ outcome: "done", detail: "review passed" }])
})

test("done on an isolated shared-tree loop checkpoints and tears down BEFORE the backlog move + commit", async () => {
  // The stranding regression: a backlog write made before teardown would be
  // committed onto feature/<id> and vanish from the human branch at checkout.
  const state: LoopState = {
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
  const checkpointAt = log.findIndex((c) => c.startsWith("git ") && c.includes("checkout")) // teardown's checkout back to base
  const moveAt = log.findIndex((c) => c.startsWith("mv ") && c.includes("in-review"))
  assert.ok(checkpointAt !== -1 && moveAt !== -1 && checkpointAt < moveAt, `teardown must precede the task move: ${log.join(" | ")}`)
  assert.deepEqual(metrics, [{ outcome: "done", detail: "review passed" }])
})

test("stop on an isolated shared-tree loop checkpoints and tears down BEFORE the note + backlog commit", async () => {
  const state: LoopState = {
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
  const state: LoopState = { goal: "Do it", stage: "build", iteration: 0, artifacts: {}, task: taskRef("t", "in-progress") }
  const { ctx, log, metrics, commits } = makeCtx({ "in-progress/t.md": body(true) }, state)
  const report = await runTerminal(ctx, stop)
  assert.equal(report.kind, "stop")
  assert.ok(!log.some((c) => c.startsWith("mv ")), "a stopped task stays where it is")
  assert.equal(commits.length, 1)
  assert.deepEqual(metrics, [{ outcome: "stopped", detail: "Loop stopped at build." }])
})

test("a source-pre-set git that never isolated leaves the main tree untouched (B5)", async () => {
  // pr-sitter triage → done "nothing actionable": git names the branch to isolate ONTO
  // but `isolated` is false, so no checkpoint/teardown may touch the human's main tree.
  const state: LoopState = {
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
