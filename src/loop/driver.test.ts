import assert from "node:assert/strict"
import { test } from "node:test"
import { PLAN_HEADING } from "@agentic-loop/core/task/store"
import { serializeTask } from "@agentic-loop/core/task/schema"
import { firstStep } from "@agentic-loop/core/loop/engine"
import type { LoopState } from "@agentic-loop/core/loop/state"
import type { Config } from "../config.ts"
import {
  abortedSessionID,
  claimSkipReason,
  drive,
  handleTaskCommand,
  manifestFor,
  onInterrupt,
  parseTaskArgs,
  parseWatchArgs,
  recordVerdict,
  type Deps,
} from "./driver.ts"

/**
 * The watch-mode plumbing (timers, idle queries) is exercised manually
 * against a live opencode; the pure parts — the interval parser, the
 * skip-reason computation, and the claim walk (`claimFirst`, in
 * `../task/store.test.ts`) — are unit-tested.
 */

test("an empty spec means 'use the config default'", () => {
  assert.deepEqual(parseWatchArgs(""), {})
  assert.deepEqual(parseWatchArgs("   "), {})
})

test("unit suffixes: seconds, minutes, hours", () => {
  assert.deepEqual(parseWatchArgs("30s"), { intervalMs: 30_000 })
  assert.deepEqual(parseWatchArgs("5m"), { intervalMs: 300_000 })
  assert.deepEqual(parseWatchArgs("2h"), { intervalMs: 7_200_000 })
})

test("a bare number is minutes", () => {
  assert.deepEqual(parseWatchArgs("5"), { intervalMs: 300_000 })
})

test("an --interval prefix is accepted", () => {
  assert.deepEqual(parseWatchArgs("--interval 5m"), { intervalMs: 300_000 })
})

test("case and internal whitespace are tolerated", () => {
  assert.deepEqual(parseWatchArgs("10 M"), { intervalMs: 600_000 })
})

test("sub-10s intervals clamp to the 10s floor", () => {
  assert.deepEqual(parseWatchArgs("1s"), { intervalMs: 10_000 })
  assert.deepEqual(parseWatchArgs("0.05"), { intervalMs: 10_000 })
})

test("garbage yields an error, not a silent default", () => {
  for (const bad of ["soon", "5x", "-5m", "m", "5m extra"]) {
    const parsed = parseWatchArgs(bad)
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(bad)}`)
  }
})

/**
 * `claimSkipReason`: every no-claim tick must explain itself. Held markers
 * outrank the other cases (they block otherwise-ready work); an empty
 * backlog is the only non-actionable outcome.
 */

test("an empty backlog (both pools) is the only non-actionable reason", () => {
  const r = claimSkipReason(0, 0, 0, [], [])
  assert.equal(r.actionable, false)
  assert.match(r.message, /queued\/ and in-progress\/ are both empty/)
})

test("held claim markers are reported with ids and the auto-release window", () => {
  const r = claimSkipReason(2, 1, 0, [], ["stuck-task"])
  assert.equal(r.actionable, true)
  assert.match(r.message, /claim marker held for stuck-task/)
  assert.match(r.message, /auto-releases after \d+m/)
})

test("held markers outrank the already-started case", () => {
  const r = claimSkipReason(2, 1, 0, ["other"], ["stuck-task"])
  assert.match(r.message, /claim marker held/)
})

test("started-but-unclaimed tasks point at /agent-loop recover", () => {
  const r = claimSkipReason(2, 0, 0, ["crashed-a", "crashed-b"], [])
  assert.equal(r.actionable, true)
  assert.match(r.message, /crashed-a, crashed-b/)
  assert.match(r.message, /\/agent-loop recover <id>/)
})

test("a backlog with neither started nor held tasks falls back to the no-plan hint", () => {
  const r = claimSkipReason(1, 0, 0, [], [])
  assert.equal(r.actionable, true)
  assert.match(r.message, /no persisted plan/)
})

/**
 * `/agent-loop-task` argument classification: `approve`/`approve-plan`/`replan`
 * are plugin work, everything else passes through to the agent turn.
 */

test("approve, approve-plan, and replan subcommands are recognized with their id", () => {
  assert.deepEqual(parseTaskArgs("approve my-task"), { mode: "approve", id: "my-task" })
  assert.deepEqual(parseTaskArgs("approve-plan my-task"), { mode: "approve-plan", id: "my-task" })
  assert.deepEqual(parseTaskArgs("replan my-task"), { mode: "replan", id: "my-task" })
})

test("replan captures an optional free-text reason", () => {
  assert.deepEqual(parseTaskArgs("replan my-task plan misses the cache layer"), {
    mode: "replan",
    id: "my-task",
    reason: "plan misses the cache layer",
  })
})

test("approve-plan wins the prefix collision with approve", () => {
  assert.deepEqual(parseTaskArgs("approve-plan x"), { mode: "approve-plan", id: "x" })
})

test("casing and surrounding whitespace are tolerated, ids keep their case", () => {
  assert.deepEqual(parseTaskArgs("  Approve My-Task  "), { mode: "approve", id: "My-Task" })
  assert.deepEqual(parseTaskArgs("REPLAN  my-task"), { mode: "replan", id: "my-task" })
})

test("a bare subcommand keeps an empty id for the usage toast", () => {
  assert.deepEqual(parseTaskArgs("approve"), { mode: "approve", id: "" })
  assert.deepEqual(parseTaskArgs("approve-plan   "), { mode: "approve-plan", id: "" })
})

test("new, retask, and free text pass through", () => {
  assert.deepEqual(parseTaskArgs("new add rate limiting"), { mode: "passthrough" })
  // retask is agent-authored (re-interview + rewrite the draft), not a deterministic move.
  assert.deepEqual(parseTaskArgs("retask my-task tighten acceptance"), { mode: "passthrough" })
  assert.deepEqual(parseTaskArgs(""), { mode: "passthrough" })
  assert.deepEqual(parseTaskArgs("approver thing"), { mode: "passthrough" })
})

/**
 * `abortedSessionID`: a user ESC surfaces only as a `MessageAbortedError`. The
 * matcher names the watched session to unwatch, and MUST stay silent on every
 * other event so the normal idle flow is untouched. This is the load-bearing
 * pure part of the interrupt wiring.
 */

test("message.updated carrying a MessageAbortedError yields the assistant session id", () => {
  const event = {
    type: "message.updated",
    properties: { info: { sessionID: "sess-1", error: { name: "MessageAbortedError" } } },
  }
  assert.equal(abortedSessionID(event), "sess-1")
})

test("session.error with a MessageAbortedError and a session id yields it", () => {
  const event = {
    type: "session.error",
    properties: { sessionID: "sess-2", error: { name: "MessageAbortedError" } },
  }
  assert.equal(abortedSessionID(event), "sess-2")
})

test("session.error abort WITHOUT a session id is unusable (optional field) → undefined", () => {
  const event = { type: "session.error", properties: { error: { name: "MessageAbortedError" } } }
  assert.equal(abortedSessionID(event), undefined)
})

test("non-abort events are ignored", () => {
  assert.equal(abortedSessionID({ type: "session.idle", properties: { sessionID: "sess" } }), undefined)
  assert.equal(
    abortedSessionID({ type: "message.updated", properties: { info: { sessionID: "sess", role: "user" } } }),
    undefined,
  )
  assert.equal(
    abortedSessionID({ type: "session.error", properties: { sessionID: "sess", error: { name: "ApiError" } } }),
    undefined,
  )
  assert.equal(abortedSessionID({ type: "message.updated", properties: {} }), undefined)
  assert.equal(abortedSessionID({ type: "message.part.updated", properties: {} }), undefined)
})

/**
 * `onInterrupt` on a session with no loop and no watch (e.g. a stray ESC while
 * idle, or a subagent's child sessionID that was never watched) must be a silent
 * no-op: no toast, and no shell call (so no spurious watch-lease release).
 */

const explodingShell = ((..._args: unknown[]) => {
  throw new Error("$ should not be called")
}) as unknown as Deps["$"]

test("onInterrupt is a silent no-op when not driving and not watching", async () => {
  const { client, toasts } = makeClient()
  const deps: Deps = { client, $: explodingShell, directory: "/repo", log: () => {} }

  await onInterrupt(deps, "sess-never-watched")

  assert.equal(toasts.length, 0)
})

/**
 * `handleTaskCommand` gates. `findByIdIn` now resolves through the shell (`cat`
 * on the real FS), so the task content lives in the shell FS mock, not the
 * client — `makeClient` only serves toasts. A refusal is proven by the absence
 * of an `mv` in the recorded command log.
 */

const makeClient = () => {
  const toasts: { message: string; variant: string }[] = []
  const client = {
    tui: {
      showToast: async ({ body }: { body: { message: string; variant: string } }) => {
        toasts.push(body)
        return { data: undefined }
      },
    },
  } as unknown as Deps["client"]
  return { client, toasts }
}

/**
 * A stateful shell FS keyed by absolute path (relative `files` keys are prefixed
 * with the `/repo` test directory). Answers `cat`/`test -f`/`mv` against the map
 * and mutates it on `mv`; every other command (printf notes, mkdir, git, rmdir)
 * succeeds. Records the normalized command stream in `log`.
 */
const makeShellFS = (files: Record<string, string>, log: string[]) => {
  const fs: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) fs[k.startsWith("/") ? k : `/repo/${k}`] = v
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    log.push(norm)
    const parts = norm.split(" ")
    let out = { exitCode: 0, stdout: "", stderr: "" }
    if (parts[0] === "cat") {
      out = parts[1]! in fs ? { exitCode: 0, stdout: fs[parts[1]!]!, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
    } else if (parts[0] === "test" && parts[1] === "-f") {
      out = { exitCode: parts[2]! in fs ? 0 : 1, stdout: "", stderr: "" }
    } else if (parts[0] === "mv") {
      const src = parts[1]!
      const dest = parts[2]!
      if (src in fs) {
        fs[dest] = fs[src]!
        delete fs[src]
        out = { exitCode: 0, stdout: "", stderr: "" }
      } else {
        out = { exitCode: 1, stdout: "", stderr: `mv: cannot stat '${src}'` }
      }
    }
    const result = {
      exitCode: out.exitCode,
      stdout: { toString: () => out.stdout },
      stderr: { toString: () => out.stderr },
    }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const testConfig: Config = {
  maxIterations: 1,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 10,
  watchIntervalMinutes: 5,
  reviewLenses: [],
  loops: {},
}

test("approve moves a draft to queued/ without requiring a plan", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/draft/my-task.md": draft }, log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})

test("approve is idempotent when the task is already queued (retry after a prior success)", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/queued/my-task.md": queued }, log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /already queued/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on an idempotent retry")
})

test("approve refuses a task that is not in draft/ or queued/", async () => {
  const inProgress = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/in-progress/my-task.md": inProgress }, log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /it's in in-progress/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("approve-plan refuses a queued task that the loop has not planned yet", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/queued/my-task.md": queued }, log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /still queued/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("approve-plan refuses a plan-review task whose plan heading is missing", async () => {
  const planless = serializeTask({ title: "Do the thing", body: "Some context, no plan." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planless }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /no Implementation Plan/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("approve-plan moves a planned plan-review task to in-progress/", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

test("replan sends a plan-review task back to queued/ with the reason noted", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleTaskCommand(deps, "sess", "replan my-task misses the cache layer", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("misses the cache layer")))
})

test("replan also accepts a cap-tripped in-progress task", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/in-progress/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleTaskCommand(deps, "sess", "replan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})

/**
 * `drive` must interpret transitions against the CLAIMED kind's manifest, not a
 * hardcoded engineering one. Regression guard for the pr-sitter drive path: its
 * stages are triage/fix/verify/publish, so an engineering-manifest lookup of
 * "triage" throws and crashes the very first transition. A `triage` FAIL parks
 * the loop as `done` ("nothing actionable") — reached only when the correct
 * (pr-sitter) manifest drives `advance`. `triage` has isolation "none", so this
 * needs no git/worktree.
 */
test("drive interprets a pr-sitter loop with the pr-sitter manifest, not engineering", async () => {
  const sessionID = "sess-pr-sitter"
  const log: string[] = []
  // A session.command that records a triage FAIL verdict through the same
  // channel the loop_verdict tool uses, then returns the stage's text.
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        recordVerdict(sessionID, "triage", { verdict: "FAIL", reason: "nothing actionable" })
        return { data: { parts: [{ type: "text", text: "triaged: no actionable signal" }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  const state: LoopState = {
    kind: "pr-sitter",
    goal: "Sit on PR #1",
    stage: "triage",
    iteration: 0,
    artifacts: {},
  }

  const outcome = await drive(deps, sessionID, testConfig, firstStep(manifestFor("pr-sitter"), state))

  assert.equal(outcome?.kind, "done")
  assert.match(outcome?.message ?? "", /nothing actionable/i)
})

/**
 * H2 regression: a real pr-sitter WorkItem pre-sets `state.git = {base, branch}` to
 * name the PR head to isolate onto. On a `triage`-FAIL → done ("nothing actionable"),
 * `triage` has isolation "none" so no isolation ever runs — the driver must NOT
 * `git add -A && commit` (would sweep the human's WIP into a bogus commit) nor
 * `git checkout <base>` (would switch their main tree to the PR base). Gated on the
 * new `state.isolated`, not on `git` being present.
 */
test("pr-sitter triage-FAIL leaves the human's main tree untouched (no commit / no checkout)", async () => {
  const sessionID = "sess-pr-git"
  const log: string[] = []
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        recordVerdict(sessionID, "triage", { verdict: "FAIL", reason: "nothing actionable" })
        return { data: { parts: [{ type: "text", text: "triaged" }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  const state: LoopState = {
    kind: "pr-sitter",
    goal: "PR #1 sit",
    stage: "triage",
    iteration: 0,
    artifacts: {},
    git: { base: "main", branch: "pr-head" }, // pre-set by prWorkItem — NOT yet isolated
  }

  const outcome = await drive(deps, sessionID, testConfig, firstStep(manifestFor("pr-sitter"), state))

  assert.equal(outcome?.kind, "done")
  const touchedTree = log.some(
    (c) => c.startsWith("git ") && (c.includes(" add -A") || c.includes(" commit") || c.includes(" checkout")),
  )
  assert.equal(touchedTree, false, `main tree was mutated: ${log.filter((c) => c.startsWith("git ")).join(" | ")}`)
})
