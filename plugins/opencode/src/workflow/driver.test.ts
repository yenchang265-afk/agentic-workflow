import assert from "node:assert/strict"
import os from "node:os"
import { test } from "node:test"
import { PLAN_HEADING } from "@agentic-workflow/core/task/store"
import { serializeTask } from "@agentic-workflow/core/task/schema"
import { firstStep } from "@agentic-workflow/core/workflow/engine"
import type { CheckResult } from "@agentic-workflow/core/workflow/checks"
import type { VerdictRecord } from "@agentic-workflow/core/workflow/verdict"
import { clearWorkflow, getWorkflow, setWorkflow, type WorkflowState } from "@agentic-workflow/core/workflow/state"
import type { Config } from "../config.ts"
import {
  abortedSessionID,
  armTaskGateAsk,
  claimSkipReason,
  configSources,
  deriveActivity,
  drive,
  handleApprove,
  isQuestionOpen,
  noteQuestionToolCall,
  noteQuestionToolSettled,
  handleCommand,
  handleAbandon,
  handleRemove,
  handleReplan,
  manifestFor,
  noteEvidence,
  noteQuestionEvent,
  onIdle,
  onInterrupt,
  parsePrTarget,
  planFromAgent,
  replanFromAgent,
  resetAskState,
  parseWatchArgs,
  recordVerdict,
  findDrivingWorkflow,
  gateCtx,
  gateFromAgent,
  resolveDrivingSession,
  runStagePasses,
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
  assert.deepEqual(parseWatchArgs("30s"), { trigger: { type: "poll", intervalMs: 30_000 } })
  assert.deepEqual(parseWatchArgs("5m"), { trigger: { type: "poll", intervalMs: 300_000 } })
  assert.deepEqual(parseWatchArgs("2h"), { trigger: { type: "poll", intervalMs: 7_200_000 } })
})

test("a bare number is minutes", () => {
  assert.deepEqual(parseWatchArgs("5"), { trigger: { type: "poll", intervalMs: 300_000 } })
})

test("an --interval prefix is accepted", () => {
  assert.deepEqual(parseWatchArgs("--interval 5m"), { trigger: { type: "poll", intervalMs: 300_000 } })
})

test("case and internal whitespace are tolerated", () => {
  assert.deepEqual(parseWatchArgs("10 M"), { trigger: { type: "poll", intervalMs: 600_000 } })
})

test("sub-10s intervals clamp to the 10s floor", () => {
  assert.deepEqual(parseWatchArgs("1s"), { trigger: { type: "poll", intervalMs: 10_000 } })
  assert.deepEqual(parseWatchArgs("0.05"), { trigger: { type: "poll", intervalMs: 10_000 } })
})

test("garbage yields an error, not a silent default", () => {
  for (const bad of ["soon", "5x", "-5m", "m", "5m extra"]) {
    const parsed = parseWatchArgs(bad)
    assert.ok("error" in parsed, `expected an error for ${JSON.stringify(bad)}`)
  }
})

test("watch accepts an in-session trigger override: idle, cron, poll", () => {
  assert.deepEqual(parseWatchArgs("idle"), { trigger: { type: "idle" } })
  assert.deepEqual(parseWatchArgs("IDLE"), { trigger: { type: "idle" } })
  assert.deepEqual(parseWatchArgs("cron */15 * * * *"), { trigger: { type: "cron", schedule: "*/15 * * * *" } })
  assert.deepEqual(parseWatchArgs('cron "0 9 * * 1-5"'), { trigger: { type: "cron", schedule: "0 9 * * 1-5" } })
  assert.deepEqual(parseWatchArgs("poll"), { trigger: { type: "poll" } })
  assert.deepEqual(parseWatchArgs("poll 30s"), { trigger: { type: "poll", intervalMs: 30_000 } })
})

test("watch rejects bad override arguments with usable errors", () => {
  const badCron = parseWatchArgs("cron not a schedule")
  assert.ok("error" in badCron && /cron/i.test(badCron.error))
  const badPoll = parseWatchArgs("poll soon")
  assert.ok("error" in badPoll && /poll interval/i.test(badPoll.error))
  const bare = parseWatchArgs("weekly")
  assert.ok("error" in bare && /poll \[interval\], cron <schedule>, or idle/.test(bare.error))
})

test("parsePrTarget reads a bare number, a #-prefixed number, and a PR URL", () => {
  assert.equal(parsePrTarget("42"), 42)
  assert.equal(parsePrTarget("#42"), 42)
  assert.equal(parsePrTarget("  7  "), 7)
  assert.equal(parsePrTarget("https://github.com/o/r/pull/128"), 128)
  assert.equal(parsePrTarget("https://dev.azure.com/acme/widgets/_git/repo/pullrequest/55"), 55)
})

test("parsePrTarget rejects junk, zero, and negatives", () => {
  for (const bad of ["", "   ", "abc", "0", "-3", "4.5", "pr-7", "12x"]) {
    assert.equal(parsePrTarget(bad), null, `expected null for ${JSON.stringify(bad)}`)
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

test("started-but-unclaimed tasks point at the recover verb", () => {
  const r = claimSkipReason(2, 0, 0, ["crashed-a", "crashed-b"], [])
  assert.equal(r.actionable, true)
  assert.match(r.message, /crashed-a, crashed-b/)
  assert.match(r.message, /\/agentic-workflow:engineering recover <id>/)
})

test("a backlog with neither started nor held tasks falls back to the no-plan hint", () => {
  const r = claimSkipReason(1, 0, 0, [], [])
  assert.equal(r.actionable, true)
  assert.match(r.message, /no persisted plan/)
})

/**
 * Verb classification of the `/agentic-workflow:engineering` command. `new` is pure
 * agent work (interview + draft write) and must pass through silently — no
 * toast, no move — so the command template's model turn runs. `retask` is the
 * hybrid: its placement half is a plugin move whose refusals are
 * report-and-stop; only a successful placement passes through to the reshape.
 */

test("new passes through without a toast or a move", async () => {
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "new add rate limiting", testConfig)

  assert.equal(toasts.length, 0)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "authoring verbs never move task files")
})

test("retask on a draft is a silent no-op — it is already where the interview needs it", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "rough" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const outcome = await handleCommand(deps, "sess", "retask my-task tighten acceptance", testConfig)

  assert.equal(outcome, undefined, "successful placement passes through — the interview markdown must reach the model")
  assert.equal(toasts.length, 0, "no toast — the agent's turn reports the reshape")
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "nothing to move")
})

test("retask on an approved queued task sends it back to draft and says so", async () => {
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: "approved, no plan yet" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const outcome = await handleCommand(deps, "sess", "retask my-task tighten acceptance", testConfig)

  assert.equal(outcome, undefined, "successful placement passes through — the interview markdown must reach the model")
  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /draft/)
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("draft")), "the task moves back to draft/")
})

test("retask on a parked plan is refused and points at replan", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Planned", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const outcome = await handleCommand(deps, "sess", "retask my-task", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /replan/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "a planned task is never moved by retask")
  // A refusal is report-and-stop: the outcome must replace the interview
  // markdown, or the model interviews against a task that is not in draft/.
  assert.equal(outcome, toasts[0]?.message, "a refused retask returns exactly what it toasted")
})

test("retask with no id is a usage outcome, not an interview", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  const outcome = await handleCommand(deps, "sess", "retask", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Usage/)
  assert.equal(outcome, toasts[0]?.message, "the usage warning replaces the interview markdown")
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
 * The deterministic gate verbs of the `/agentic-workflow:engineering` command.
 * `findByIdIn` resolves through the shell (`cat` on the real FS), so the task
 * content lives in the shell FS mock, not the client — `makeClient` only
 * serves toasts. A refusal is proven by the absence of an `mv` in the
 * recorded command log.
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
/** Canned result for a command whose normalized form starts with `cmd`. */
type ShellOverride = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

const makeShellFS = (files: Record<string, string>, log: string[], overrides: ShellOverride[] = []) => {
  const fs: Record<string, string> = {}
  for (const [k, v] of Object.entries(files)) fs[k.startsWith("/") ? k : `/repo/${k}`] = v
  // Directories created by a bare `mkdir` — the claim marker's atomicity is
  // "mkdir fails on an existing dir", so a fake that always succeeds cannot
  // model a claim takeover (release, then win the same path).
  const mkdirs = new Set<string>()
  const isDir = (p: string): boolean => mkdirs.has(p) || Object.keys(fs).some((k) => k.startsWith(`${p}/`))
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
    const override = overrides.find((o) => norm.startsWith(o.cmd))
    if (override) {
      const r = override.result
      const result = { exitCode: r.exitCode ?? 0, stdout: { toString: () => r.stdout ?? "" }, stderr: { toString: () => r.stderr ?? "" } }
      const chain = {
        quiet: () => chain,
        nothrow: () => chain,
        cwd: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      }
      return chain
    }
    const parts = norm.split(" ")
    let out = { exitCode: 0, stdout: "", stderr: "" }
    if (parts[0] === "cat") {
      out = parts[1]! in fs ? { exitCode: 0, stdout: fs[parts[1]!]!, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
    } else if (parts[0] === "test" && (parts[1] === "-f" || parts[1] === "-e")) {
      out = { exitCode: parts[2]! in fs ? 0 : 1, stdout: "", stderr: "" }
    } else if (parts[0] === "mkdir") {
      if (parts[1] === "-p") {
        mkdirs.add(parts[2]!)
        out = { exitCode: 0, stdout: "", stderr: "" }
      } else if (isDir(parts[1]!)) {
        out = { exitCode: 1, stdout: "", stderr: "File exists" } // EEXIST — the atomic loser
      } else {
        mkdirs.add(parts[1]!)
        out = { exitCode: 0, stdout: "", stderr: "" }
      }
    } else if (parts[0] === "test" && parts[1] === "-d") {
      out = { exitCode: isDir(parts[2]!) ? 0 : 1, stdout: "", stderr: "" }
    } else if (parts[0] === "mv") {
      // `-n` is modelled, not skipped: production relies on it to make the kernel
      // arbitrate a concurrent create.
      const noClobber = parts.includes("-n")
      const [src, dest] = parts.slice(1).filter((p) => !p.startsWith("-")) as [string, string]
      if (noClobber && dest in fs) {
        out = { exitCode: 0, stdout: "", stderr: "" } // successful no-op; source survives
      } else if (src in fs) {
        fs[dest] = fs[src]!
        delete fs[src]
        out = { exitCode: 0, stdout: "", stderr: "" }
      } else if (isDir(src)) {
        // A directory move carries its contents — which is what lets the claim
        // sweep's rename-aside re-judge the stamp it actually caught.
        for (const k of Object.keys(fs)) {
          if (!k.startsWith(`${src}/`)) continue
          fs[dest + k.slice(src.length)] = fs[k]!
          delete fs[k]
        }
        mkdirs.delete(src)
        mkdirs.add(dest)
        out = { exitCode: 0, stdout: "", stderr: "" }
      } else {
        out = { exitCode: 1, stdout: "", stderr: `mv: cannot stat '${src}'` }
      }
    } else if (parts[0] === "rmdir") {
      mkdirs.delete(parts[1]!)
      out = { exitCode: 0, stdout: "", stderr: "" }
    } else if (parts[0] === "rm") {
      // rm [-rf] <path…> — drop the listed paths (and, with -r, anything under
      // them) from the fake fs; missing is fine.
      const recursive = parts.some((p) => p.startsWith("-") && p.includes("r"))
      for (const p of parts.slice(1)) {
        if (p.startsWith("-")) continue
        delete fs[p]
        if (!recursive) continue
        mkdirs.delete(p)
        for (const k of Object.keys(fs)) if (k.startsWith(`${p}/`)) delete fs[k]
      }
      out = { exitCode: 0, stdout: "", stderr: "" }
    } else if (parts[0] === "ls" && parts[1]) {
      // Short-id resolution lists a status folder — serve the fake fs's basenames.
      const dir = parts[1]!
      const names = Object.keys(fs)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1))
        .filter((n) => !n.includes("/"))
      out = names.length ? { exitCode: 0, stdout: names.join("\n"), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
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
  ignoreBacklog: true,
  stageTimeoutMinutes: 10,
  checkTimeoutMinutes: 10,
  watchIntervalMinutes: 5,
  worktreesDir: false,
  taskBranch: "feature/",
  reviewLenses: [],
  workflows: {},
}

test("approve <id> moves a draft to queued/ without requiring a plan (unified gate)", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/draft/my-task.md": draft }, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})


test("approve <id> is idempotent when the task is already queued (retry after a prior success)", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/queued/my-task.md": queued }, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /is in queued/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on an idempotent retry")
})

test("approve <id> on a task at no gate (in-progress) reports info, no move", async () => {
  const inProgress = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/in-progress/my-task.md": inProgress }, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /is in in-progress/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("plan <short-id> resolves the short-hash handle and starts planning", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Just a body, no plan yet." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/queued/f7k3-do-the-thing.md": queued }, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess-plan-short", "plan f7k3", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /planning…/, `unexpected toast: ${toasts[0]?.message}`)
})

test("plan <id> refuses while this session is already driving a loop (no clearWorkflow clobber)", async () => {
  // A watch session mid-BUILD on task A has live loop state; `plan C` used to
  // clearWorkflow it unconditionally, silently abandoning A at the next stage
  // boundary. It must refuse with the same busy guard `claim` uses.
  const sessionID = "sess-busy-plan"
  const busy: WorkflowState = { goal: "task A", stage: "build", iteration: 1, artifacts: {} }
  setWorkflow(sessionID, busy)
  try {
    const queued = serializeTask({ title: "Do the thing", body: "Just a body, no plan yet." })
    const { client, toasts } = makeClient()
    const log: string[] = []
    const deps: Deps = { client, $: makeShellFS({ "docs/tasks/queued/f7k3-do-the-thing.md": queued }, log), directory: "/repo", log: () => {} }

    await handleCommand(deps, sessionID, "plan f7k3", testConfig)

    assert.equal(toasts.length, 1)
    assert.match(toasts[0]?.message ?? "", /already driving in this session/)
    assert.ok(!log.some((cmd) => cmd.startsWith("mkdir ")), "no claim marker was taken")
  } finally {
    clearWorkflow(sessionID)
  }
})

test("recover <id> refuses while this session is already driving a loop (no clearWorkflow clobber)", async () => {
  const sessionID = "sess-busy-recover"
  const busy: WorkflowState = { goal: "task A", stage: "build", iteration: 1, artifacts: {} }
  setWorkflow(sessionID, busy)
  try {
    const inProgress = serializeTask({ title: "Other task", body: `${PLAN_HEADING}\n\n1. Step.` })
    const { client, toasts } = makeClient()
    const log: string[] = []
    const deps: Deps = { client, $: makeShellFS({ "docs/tasks/in-progress/other.md": inProgress }, log), directory: "/repo", log: () => {} }

    await handleCommand(deps, sessionID, "recover other", testConfig)

    assert.equal(toasts.length, 1)
    assert.match(toasts[0]?.message ?? "", /already driving in this session/)
  } finally {
    clearWorkflow(sessionID)
  }
})

test("recover <id> refuses a fresh claim with no stage marker (pre-marker setup window)", async () => {
  // The unconditional-takeover regression: a just-claimed live run spends
  // minutes in isolation/stage-check setup BEFORE writing its first stage
  // marker. recover used to sweep the claim with minutes:0 there, starting a
  // second drive on the same feature/<id> branch. With no crash evidence (no
  // stage marker naming the task), only a stale claim stamp may authorize the
  // takeover.
  const body = serializeTask({
    title: "Maybe crashed",
    body: `${PLAN_HEADING}\n\n1. Step.\n\n> CLAIMED — loop starting [2026-01-01T00:00:00.000Z]`,
  })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS(
      {
        "docs/tasks/in-progress/t.md": body,
        "docs/tasks/in-progress/.claims/t/claim.json": JSON.stringify({ claimedAt: new Date().toISOString() }),
      },
      log,
      [{ cmd: "mkdir /repo/docs/tasks/in-progress/.claims/t", result: { exitCode: 1 } }],
    ),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess-recover-freshclaim", "recover t", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /still be setting up before its first stage/, toasts[0]?.message)
})

/** A pid no probe in these tests reports as running. */
const DEAD_PID = 999_201

/** The `recover` fixture: a started, planned task whose claim marker is held. */
const heldClaimFixture = (stamp: Record<string, unknown>) => ({
  "docs/tasks/in-progress/t.md": serializeTask({
    title: "Maybe crashed",
    body: `${PLAN_HEADING}\n\n1. Step.\n\n> CLAIMED — loop starting [2026-01-01T00:00:00.000Z]`,
  }),
  "docs/tasks/in-progress/.claims/t/claim.json": JSON.stringify(stamp),
})

/** Probe results that make DEAD_PID provably gone and this process provably live. */
const deadPidProbes: ShellOverride[] = [
  { cmd: `kill -0 ${String(DEAD_PID)}`, result: { exitCode: 1 } },
  { cmd: `test -d /proc/${String(DEAD_PID)}`, result: { exitCode: 1 } },
  { cmd: `test -d /proc/${String(process.pid)}`, result: { exitCode: 0 } },
]

test("recover <id> takes over immediately when the claim's writer is provably dead", async () => {
  // The reported bug: a run that died BEFORE writing its first stage marker left
  // no crash evidence, so recover made the human wait out the 15-minute window
  // behind advice ("stop it first") that no other process can act on. The claim
  // stamp's own writer pid is the evidence that exists in that window.
  const fixture = heldClaimFixture({ claimedAt: new Date().toISOString(), pid: DEAD_PID, host: os.hostname() })
  // No state snapshot on disk — the crash happened before the first stage, so
  // recover re-enters at BUILD from the persisted plan.
  const { client, toasts } = makeClientFS(fixture)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(fixture, log, deadPidProbes), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess-recover-deadwriter", "recover t", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /Recovering/, toasts[0]?.message)
  // The takeover is the atomic rename-aside, never a blind rmdir + mkdir.
  assert.ok(
    log.some((c) => c.startsWith("mv /repo/docs/tasks/in-progress/.claims/t ") && c.includes(".claims/t.dead-")),
    "swept through the rename-aside",
  )
})

test("recover <id> still refuses while the claim's writer is alive", async () => {
  // A live claimer inside its setup window is exactly what the wall-clock window
  // exists to protect; only the unactionable advice changes.
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS(heldClaimFixture({ claimedAt: new Date().toISOString(), pid: process.pid, host: os.hostname() }), log, [
      { cmd: `kill -0 ${String(process.pid)}`, result: { exitCode: 0 } },
    ]),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess-recover-livewriter", "recover t", testConfig)

  assert.equal(toasts.length, 1)
  const msg = toasts[0]?.message ?? ""
  assert.match(msg, /held by a live process on this machine/, msg)
  assert.doesNotMatch(msg, /Stop it first/, "the advice a crashed claimer made unactionable is gone")
  assert.ok(
    !log.some((c) => c.startsWith("mv /repo/docs/tasks/in-progress/.claims/t ")),
    "a live claim is never swept",
  )
})

test("recover <id> refuses a dead-pid claim stamped on ANOTHER machine", async () => {
  // A repo shared across machines or sibling containers: a pid from over there
  // says nothing here, and concluding death would start a second drive.
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS(heldClaimFixture({ claimedAt: new Date().toISOString(), pid: DEAD_PID, host: "some-other-box" }), log, deadPidProbes),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess-recover-foreign", "recover t", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /cannot be identified on this machine/, toasts[0]?.message)
  assert.ok(!log.some((c) => c.startsWith("mv /repo/docs/tasks/in-progress/.claims/t ")))
})

test("plan <id> on a plan-review task points at the gate verbs, no move", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "plan my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /parked for review/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("approve <id> refuses a plan-review task whose plan heading is missing", async () => {
  const planless = serializeTask({ title: "Do the thing", body: "Some context, no plan." })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planless }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /no Implementation Plan/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on a refusal")
})

test("approve <id> moves a planned plan-review task to in-progress/", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

test("replan sends a plan-review task back with the reason noted, then chains the re-plan", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  const outcome = await handleCommand(deps, "sess-replan-chain", "replan my-task misses the cache layer", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /re-planning now/, `unexpected toast: ${toasts[0]?.message}`)
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("misses the cache layer")))
  assert.ok(
    log.some((cmd) => cmd.startsWith("mkdir /repo/docs/tasks/queued/.claims/my-task")),
    "the chain claims the requeued task for this session's PLAN drive",
  )
  // Report-and-stop: the outcome rides back to the command hook so it can
  // replace the rendered markdown — a toast alone is invisible to the model.
  assert.equal(outcome, toasts[0]?.message, "replan returns exactly what it toasted")
})

test("replan also accepts a cap-tripped in-progress task and chains its re-plan", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/in-progress/my-task.md": planned }, log),
    directory: "/repo",
    log: () => {},
  }

  await handleCommand(deps, "sess-replan-cap", "replan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /re-planning now/)
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})

test("replan while this session is driving falls back to plan-next — rejection lands, no chain", async () => {
  const sessionID = "sess-replan-busy"
  const busy: WorkflowState = { goal: "task A", stage: "build", iteration: 1, artifacts: {} }
  setWorkflow(sessionID, busy)
  try {
    const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
    const { client, toasts } = makeClient()
    const log: string[] = []
    const deps: Deps = { client, $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log), directory: "/repo", log: () => {} }

    await handleReplan(deps, sessionID, "my-task wrong approach", testConfig)

    assert.equal(toasts[0]?.variant, "success")
    assert.match(toasts[0]?.message ?? "", /plan-next/, "core's message already promises the next PLAN pass")
    assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the rejection move still lands")
    assert.ok(
      !log.some((cmd) => cmd.startsWith("mkdir /repo/docs/tasks/queued/.claims/my-task")),
      "no chain claim under a busy session",
    )
  } finally {
    clearWorkflow(sessionID)
  }
})

test("replan falls back to plan-next when another watcher wins the requeued task's claim", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = {
    client,
    // The chain's `mkdir <queued>/.claims/my-task` loses the race — modelled as
    // the marker mkdir failing, exactly how a rival's earlier mkdir surfaces.
    $: makeShellFS({ "docs/tasks/plan-review/my-task.md": planned }, log, [
      { cmd: "mkdir /repo/docs/tasks/queued/.claims/my-task", result: { exitCode: 1 } },
    ]),
    directory: "/repo",
    log: () => {},
  }

  await handleReplan(deps, "sess-replan-race", "my-task wrong approach", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /plan-next/, "the raced chain reports core's outcome — the winner re-plans it")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the rejection move still lands")
})

/**
 * `/approve` and `/reject` — the folder-driven gate shortcuts. The no-id path
 * enumerates candidates through the CLIENT (`file.list`/`file.read`), then the
 * move runs through the shell — so these need a client backed by the same file
 * map as the shell. `makeClientFS` serves both from one `files` input; node
 * `absolute` paths line up with the shell keys so a listed task's `mv` matches.
 */
const makeClientFS = (files: Record<string, string>) => {
  const toasts: { message: string; variant: string }[] = []
  const rel = (p: string) => (p.startsWith("/repo/") ? p.slice("/repo/".length) : p)
  const client = {
    tui: {
      showToast: async ({ body }: { body: { message: string; variant: string } }) => {
        toasts.push(body)
        return { data: undefined }
      },
    },
    file: {
      list: async ({ query }: { query: { path: string; directory: string } }) => {
        const dir = query.path.replace(/\/$/, "")
        const data = Object.keys(files)
          .filter((k) => k.slice(0, k.lastIndexOf("/")) === dir)
          .map((k) => {
            const name = k.slice(k.lastIndexOf("/") + 1)
            return { type: "file" as const, name, path: k, absolute: `/repo/${k}` }
          })
        return { data }
      },
      read: async ({ query }: { query: { path: string; directory: string } }) => {
        const key = rel(query.path)
        return { data: key in files ? { content: files[key] } : undefined }
      },
    },
    // A root session with no parent. The model-callable gate tools walk this
    // chain to refuse a call coming from inside a running loop, and they fail
    // CLOSED — so a client without it would refuse everything.
    session: { get: async () => ({ data: { parentID: undefined } }) },
  } as unknown as Deps["client"]
  return { client, toasts }
}

test("/approve with no id advances the single plan-review task to in-progress/", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

/**
 * The model-callable gate tools. They exist because this host has no MCP server
 * and guards every write under `docs/tasks/` — so a `new`/`retask` turn that
 * asks "approve this draft?" with the `question` tool had no way to honour a
 * yes, which made the ask theatre.
 *
 * The danger they introduce is the reason for the guard: a tool in the plugin's
 * `tool:` map is offered to EVERY session, stage subagents included, so an
 * unguarded one lets a BUILD or REVIEW agent approve the task it is driving.
 */
test("workflow_gate moves the draft the user just approved, and asks what is next", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const out = await gateFromAgent(deps, "sess-agent", "my-task", testConfig)

  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the task gate must actually move the file")
  assert.equal(toasts[0]?.variant, "success")
  assert.match(out, /NEXT STEP/, "the answer to 'approve?' is worthless without the 'plan it now?' follow-up")
  assert.match(out, /workflow_plan/)
  assert.match(out, /my-task/)
})

test("a gate tool called from inside a running loop is refused, and moves nothing", async () => {
  const sessionID = "sess-stage-agent"
  const busy: WorkflowState = { goal: "task A", stage: "build", iteration: 1, artifacts: {} }
  setWorkflow(sessionID, busy)
  try {
    const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
    const { client } = makeClientFS(files)
    const log: string[] = []
    const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

    for (const out of [await gateFromAgent(deps, sessionID, "my-task", testConfig), await planFromAgent(deps, sessionID, "my-task", testConfig)]) {
      assert.match(out, /may not move the human's gates|already driving/, `unexpected: ${out}`)
    }
    assert.ok(!log.some((cmd) => cmd.includes("mv")), "a stage agent must never move a task through a gate")
  } finally {
    clearWorkflow(sessionID)
  }
})

// Fail CLOSED, unlike the Claude spawn guard: a false refusal costs one command
// the human can type, a false allow lets an unidentified caller ship work.
/**
 * A gate verb's shell is BOUNDED, unlike `deps.$` everywhere else.
 *
 * The reported failure was a `workflow_gate` that never returned: the task file
 * had already moved, the model's turn sat behind a tool call stuck at `running`,
 * and the only way out was killing opencode. Whatever the stalling command turns
 * out to be, a gate move must degrade — core reads exit 124 as an ordinary
 * failed command, so the move still reports and only its best-effort bookkeeping
 * is skipped.
 */
test("the shell a gate verb runs is bounded, not deps.$", async () => {
  const { client } = makeClientFS({})
  const hangs = (() => ({
    quiet() {
      return this
    },
    nothrow() {
      return this
    },
    cwd() {
      return this
    },
    then: () => {},
  })) as unknown as Deps["$"]
  const deps: Deps = { client, $: hangs, directory: "/repo", log: () => {} }

  // `.timeout()` narrows the wrapper's own cap, which is how this asserts in
  // milliseconds what ships as a 60s ceiling.
  const out = await gateCtx(deps, testConfig).$`git add -- ${"docs/tasks"}`.quiet().nothrow().timeout?.(20)

  assert.equal(out?.exitCode, 124, "a gate command that never settles must resolve like a failed one")
})

test("a gate tool refuses when it cannot tell which session is calling", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const blind = { ...client, session: { get: async () => { throw new Error("session api down") } } } as unknown as Deps["client"]
  const deps: Deps = { client: blind, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  assert.match(await gateFromAgent(deps, "sess-unknown", "my-task", testConfig), /refusing the gate move/)
  assert.ok(!log.some((cmd) => cmd.includes("mv")))
})

/**
 * The "plan it now?" ask, and why it is a MECHANISM rather than the prose that
 * asks for it.
 *
 * `workflow_plan` is the point of no return for the human's session: it claims
 * the task, and the drive that follows runs its stages as `session.command` calls
 * on that same session, after which `refuseIfDriven` and the absence of a free
 * model turn mean nothing can ask them anything until the chain unwinds. So an
 * orchestrator that reads the `NEXT STEP` line and skips straight to
 * `workflow_plan` produces exactly the reported symptom — no window, and a PLAN
 * pass already running. The refusal below is what makes "the model skipped the
 * ask" distinguishable from "the human said yes".
 */
const asked = (sessionID: string) => noteQuestionEvent({ type: "question.asked", properties: { sessionID } })
const answered = (sessionID: string) => noteQuestionEvent({ type: "question.replied", properties: { sessionID } })

const draftFixture = () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }
  return { files, client, toasts, log, deps }
}

test("workflow_plan refuses when the gate's question was never put to the human", async () => {
  resetAskState()
  const sessionID = "sess-skips-the-ask"
  const { deps, log } = draftFixture()
  // The `new` interview's own "Approve <id> now?" — this is what proves questions
  // are observable in this session at all.
  asked(sessionID)
  answered(sessionID)

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  const before = log.length
  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)

  assert.match(out, /never asked the human/, `unexpected: ${out}`)
  assert.match(out, /NEXT STEP/, "a refusal that does not say what to do instead just stalls the turn")
  assert.deepEqual(log.slice(before), [], "a refused workflow_plan must not claim, resolve, or move anything")
})

test("workflow_plan proceeds once the question has actually been asked", async () => {
  resetAskState()
  const sessionID = "sess-asks-properly"
  const { deps } = draftFixture()
  asked(sessionID)
  answered(sessionID)

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  asked(sessionID) // "Plan `my-task` now?"
  answered(sessionID) // …yes
  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)

  assert.match(out, /Loop started on "Do the thing" — planning…/, `unexpected: ${out}`)
})

/**
 * The regression the per-id keying closes. `askArmed` held ONE slot per session,
 * so gating a second child overwrote the first child's arm — and a slice-set walk
 * gates several children in one session by design. Planning the first one then
 * passed unchecked, on a task the human may have just said "not yet" to, and
 * `workflow_plan` is the point of no return.
 */
test("gating a sibling does not disarm the first slice's ask", async () => {
  resetAskState()
  const sessionID = "sess-slice-walk"
  const files = {
    "docs/tasks/draft/slice-a.md": serializeTask({ title: "Slice A", epic: "k2p9", priority: 0, body: "a" }),
    "docs/tasks/draft/slice-b.md": serializeTask({ title: "Slice B", epic: "k2p9", priority: 1, body: "b" }),
  }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }
  asked(sessionID) // the walk's own "Approve slice-a now?"
  answered(sessionID)

  await gateFromAgent(deps, sessionID, "slice-a", testConfig)
  await gateFromAgent(deps, sessionID, "slice-b", testConfig)
  const out = await planFromAgent(deps, sessionID, "slice-a", testConfig)

  assert.match(out, /never asked the human/, `slice-a's ask must survive slice-b being gated — got: ${out}`)
})

test("each slice's ask is spent on its own, so a sibling still owes its question", async () => {
  resetAskState()
  const sessionID = "sess-slice-spend"
  const files = {
    "docs/tasks/draft/slice-a.md": serializeTask({ title: "Slice A", epic: "k2p9", priority: 0, body: "a" }),
    "docs/tasks/draft/slice-b.md": serializeTask({ title: "Slice B", epic: "k2p9", priority: 1, body: "b" }),
  }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }
  asked(sessionID)
  answered(sessionID)

  await gateFromAgent(deps, sessionID, "slice-a", testConfig)
  await gateFromAgent(deps, sessionID, "slice-b", testConfig)
  asked(sessionID) // "Plan slice-a now?" — marks both, which is the imprecision we keep
  answered(sessionID)
  await planFromAgent(deps, sessionID, "slice-a", testConfig)
  // Spending A's ask must not resurrect a demand on B, nor delete B's record.
  const out = await planFromAgent(deps, sessionID, "slice-b", testConfig)
  assert.doesNotMatch(out, /never asked the human/, `unexpected: ${out}`)
})

/**
 * The refusal restates the arming call VERBATIM, walk included — a paraphrase
 * would leave the model reconciling two texts that disagree about what to do.
 */
test("the refusal reproduces the same NEXT STEP the gate emitted, slice walk and all", async () => {
  resetAskState()
  const sessionID = "sess-same-words"
  const files = {
    "docs/tasks/draft/slice-a.md": serializeTask({ title: "Slice A", epic: "k2p9", priority: 0, body: "a" }),
    "docs/tasks/draft/slice-b.md": serializeTask({ title: "Slice B", epic: "k2p9", priority: 1, body: "b" }),
  }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }
  asked(sessionID)
  answered(sessionID)

  const gate = await gateFromAgent(deps, sessionID, "slice-a", testConfig)
  const refusal = await planFromAgent(deps, sessionID, "slice-a", testConfig)

  const tail = (s: string) => s.slice(s.indexOf("NEXT STEP"))
  assert.equal(tail(refusal), tail(gate), "the two must be the same words, not a paraphrase")
  assert.match(tail(refusal), /Approve `slice-b` now\?/)
})

/**
 * The bootstrap that keeps this fail-OPEN. Enforcement applies only to a session
 * where a question has been seen, so against a host that never emits the events
 * the rule goes inert instead of stranding every task behind a question nothing
 * can ask. A false allow only restores the old behaviour; a false refusal leaves
 * an approved task no verb can plan.
 */
test("workflow_plan is never refused in a session where questions are not observable", async () => {
  resetAskState()
  const sessionID = "sess-no-questions-here"
  const { deps } = draftFixture()

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)

  assert.match(out, /Loop started on "Do the thing" — planning…/, `unexpected: ${out}`)
})

test("the armed ask is one-shot — a second workflow_plan is not re-refused", async () => {
  resetAskState()
  const sessionID = "sess-one-shot"
  const { deps } = draftFixture()
  asked(sessionID)
  answered(sessionID)

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  assert.match(await planFromAgent(deps, sessionID, "my-task", testConfig), /never asked the human/)
  asked(sessionID)
  answered(sessionID)
  await planFromAgent(deps, sessionID, "my-task", testConfig)
  // The ask is spent by the call that satisfied it: re-demanding it on a retry
  // would teach the orchestrator to ask the same question twice.
  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)
  assert.doesNotMatch(out, /never asked the human/, `unexpected: ${out}`)
})

/**
 * The other half of the same bug. Even a model that asks correctly loses the
 * window if an idle tick hands the session to a drive while it is up — stages run
 * on the DRIVING session, so claiming here takes over the very session the human
 * is being asked in.
 */
test("onIdle drives nothing while a question is open, and leaves the work queued", async () => {
  resetAskState()
  const sessionID = "sess-mid-question"
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client } = makeClientFS(files)
  const commands: string[] = []
  const log: string[] = []
  const withCommand = {
    ...client,
    session: {
      get: async () => ({ data: { parentID: undefined } }),
      command: async ({ body }: { body: { command: string } }) => {
        commands.push(body.command)
        return { data: { parts: [], info: undefined } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client: withCommand, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  // Queue a PLAN drive the way `workflow_plan` does, then open a question.
  await planFromAgent(deps, sessionID, "my-task", testConfig)
  asked(sessionID)
  await onIdle(deps, sessionID, testConfig)
  assert.deepEqual(commands, [], "a drive must not take over a session the human is being asked in")

  // The answer lands; the work was still queued, so the next idle drains it.
  answered(sessionID)
  await onIdle(deps, sessionID, testConfig)
  assert.deepEqual(commands, ["plan-task"], "returning before pending.delete must leave the drive to the next idle, not drop it")
  clearWorkflow(sessionID)
})

/**
 * The bus events are named by the HOST, and the SDK's event union carries two
 * families for one window (`question.asked` and `question.v2.asked`, both with a
 * `sessionID`). Which one a given build delivers is not something this plugin can
 * be relied on to have guessed right — and getting it wrong is invisible, because
 * every rule downstream fails open. So both are accepted.
 */
test("the v2 question event names are the same window under another name", async () => {
  resetAskState()
  const sessionID = "sess-v2-events"
  const { deps } = draftFixture()

  assert.equal(noteQuestionEvent({ type: "question.v2.asked", properties: { sessionID } }), true, "a v2 event is still a question event, not an idle one")
  assert.ok(isQuestionOpen(sessionID), "a v2 window is a window")

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  noteQuestionEvent({ type: "question.v2.asked", properties: { sessionID } }) // "Plan `my-task` now?"
  noteQuestionEvent({ type: "question.v2.replied", properties: { sessionID } })
  assert.ok(!isQuestionOpen(sessionID), "a v2 settlement must close what a v2 ask opened")

  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)
  assert.match(out, /Loop started on "Do the thing" — planning…/, `unexpected: ${out}`)
  clearWorkflow(sessionID)
})

/**
 * The signal that does not depend on a host event name at all: the model's own
 * `question` tool call, seen through the plugin's own `tool.execute.*` hooks. If
 * the events go quiet — renamed, unbridged, not forwarded to plugins — this is
 * what still tells the gate its question was put. Without it, `f71f5d2`'s whole
 * mechanism degrades to nothing with no way to tell from a transcript.
 */
test("a question TOOL CALL alone satisfies the gate's ask, with no bus event at all", async () => {
  resetAskState()
  const sessionID = "sess-tool-only"
  const { deps } = draftFixture()
  noteQuestionToolCall(sessionID, "call-approve") // "Approve `my-task` now?"
  noteQuestionToolSettled(sessionID, "call-approve")

  await gateFromAgent(deps, sessionID, "my-task", testConfig)
  assert.match(await planFromAgent(deps, sessionID, "my-task", testConfig), /never asked the human/, "the tool-call source must enforce, not just observe")

  noteQuestionToolCall(sessionID, "call-plan") // "Plan `my-task` now?"
  assert.ok(isQuestionOpen(sessionID), "an open tool call is an open window — onIdle must hold off")
  noteQuestionToolSettled(sessionID, "call-plan")
  assert.ok(!isQuestionOpen(sessionID))

  const out = await planFromAgent(deps, sessionID, "my-task", testConfig)
  assert.match(out, /Loop started on "Do the thing" — planning…/, `unexpected: ${out}`)
  clearWorkflow(sessionID)
})

/**
 * Both sources report the SAME window in the normal case, and the asked event
 * carries the tool's own `callID` — so they have to converge on one record. Under
 * a per-session flag they did; under per-window tokens they only do if the token
 * is derived from that callID, and getting it wrong leaves a token no settlement
 * removes, which is a session `onIdle` never drives again.
 */
test("the tool call and its bus event are one window, not two", async () => {
  resetAskState()
  const sessionID = "sess-both-sources"
  noteQuestionToolCall(sessionID, "c1")
  noteQuestionEvent({ type: "question.asked", properties: { sessionID, id: "req-1", tool: { messageID: "m1", callID: "c1" } } })
  // One settlement, naming only the request — the link back to the call is what
  // makes it close the token the tool call filed.
  noteQuestionEvent({ type: "question.replied", properties: { sessionID, requestID: "req-1" } })
  assert.ok(!isQuestionOpen(sessionID), "two reports of one window must not need two settlements")
})

test("a settlement nobody can attribute clears the session rather than leaking a token", () => {
  resetAskState()
  const sessionID = "sess-unattributable"
  noteQuestionToolCall(sessionID, "c1")
  // No requestID to resolve: a token left behind here is permanent, and `onIdle`
  // returns on it for the life of the process.
  noteQuestionEvent({ type: "question.rejected", properties: { sessionID } })
  assert.ok(!isQuestionOpen(sessionID))
})

/**
 * One assistant message may open two windows. A per-session flag loses this: the
 * first settlement clears it and a drive claims the session out from under the
 * window still up — the exact bug the guard exists to stop.
 */
test("settling one of two open windows leaves the session non-claimable", () => {
  resetAskState()
  const sessionID = "sess-two-windows"
  noteQuestionToolCall(sessionID, "c1")
  noteQuestionToolCall(sessionID, "c2")
  noteQuestionToolSettled(sessionID, "c1")
  assert.ok(isQuestionOpen(sessionID), "the second window is still up")
  noteQuestionToolSettled(sessionID, "c2")
  assert.ok(!isQuestionOpen(sessionID))
})

/**
 * The wedge this fix exists to close. `onIdle` returns while a window is open and
 * does so BEFORE `pending.delete`, so a window that dies without a settlement
 * strands the queued drive and the on-disk claim it already placed — for the life
 * of the process, with every gate verb then refusing the task as "a loop is
 * driving this NOW". ESC is the way a window dies silently, so ESC has to clear
 * it; there is deliberately no timeout, because a window the human has not got to
 * yet is legitimately open for hours.
 */
test("ESC on an open question un-wedges the session instead of stranding its drive", async () => {
  resetAskState()
  const sessionID = "sess-esc-mid-question"
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client } = makeClientFS(files)
  const commands: string[] = []
  const log: string[] = []
  const withCommand = {
    ...client,
    session: {
      get: async () => ({ data: { parentID: undefined } }),
      abort: async () => ({ data: true }),
      command: async ({ body }: { body: { command: string } }) => {
        commands.push(body.command)
        return { data: { parts: [], info: undefined } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client: withCommand, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  noteQuestionToolCall(sessionID, "c1")
  await onIdle(deps, sessionID, testConfig)
  assert.ok(isQuestionOpen(sessionID))

  await onInterrupt(deps, sessionID)
  assert.ok(!isQuestionOpen(sessionID), "a dismissed window must not outlive the turn it was opened in")

  // And the session works again: a fresh claim drives rather than silently returning.
  await planFromAgent(deps, sessionID, "my-task", testConfig)
  await onIdle(deps, sessionID, testConfig)
  assert.deepEqual(commands, ["plan-task"], "onIdle must be reachable again after the interrupt")
  clearWorkflow(sessionID)
})

/**
 * `data.gate`/`data.id` come from CORE, which resolves to `packages/core/dist` —
 * gitignored, rebuilt only by `npm install`, while the installed plugin points at
 * the working tree. A new plugin against an old core dist therefore lands here
 * with `r.ok` true and no gate on it, and used to do so in total silence: no
 * `NEXT STEP` for the model to follow AND nothing armed for `askUnanswered` to
 * enforce, so the human's session was claimed without ever being asked.
 */
test("a gate result with no gate says so, instead of dropping the ask silently", () => {
  resetAskState()
  const sessionID = "sess-stale-core"
  const warnings: string[] = []
  const log = (level: string, message: string) => void (level === "warn" && warnings.push(message))

  // What a core dist predating the gate contract returns: the move landed, the
  // data that says WHICH gate did not.
  assert.equal(armTaskGateAsk(sessionID, { approved: true }, log), "", "there is no id to ask about")
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`)
  assert.match(warnings[0]!, /npm install/, "the warning has to name the fix, or it is just noise")

  // The plan and ship gates legitimately do not ask — warning on those would
  // train the operator to ignore the one that matters.
  assert.equal(armTaskGateAsk(sessionID, { approved: true, gate: "plan", id: "my-task" }, log), "")
  assert.equal(warnings.length, 1, "a gate that simply does not ask is not a defect")
})

/**
 * The fail-OPEN exit, which must stay open (a false refusal strands an approved
 * task no verb can plan) but must no longer be silent: "the human said yes" and
 * "we could not tell" produced the same outcome and the same empty log.
 */
test("waving through a plan we could not check is logged", async () => {
  resetAskState()
  const sessionID = "sess-unobservable"
  const warnings: string[] = []
  const { deps } = draftFixture()
  const noted: Deps = { ...deps, log: (level, message) => level === "warn" && warnings.push(message) }

  await gateFromAgent(noted, sessionID, "my-task", testConfig)
  const out = await planFromAgent(noted, sessionID, "my-task", testConfig)

  assert.match(out, /Loop started on "Do the thing" — planning…/, "fail-open: never refuse what we cannot observe")
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`)
  assert.match(warnings[0]!, /no question has ever been observed/)
  clearWorkflow(sessionID)
})

/**
 * The PLAN GATE ask. `plan <id>` returns before the drive even starts (the stage
 * runs on a later idle), so when the plan finally parks there is no model turn
 * left to ask in — which is why this host simply never asked and left the human
 * to type the verb. The plugin cannot originate a QUESTION, but it can originate
 * the TURN in which the model asks one, and that is what these pin: that it fires
 * on a human-requested park, and on nothing else.
 */
const PLANNED_BODY = [
  "## Implementation Plan",
  "",
  "1. Edit `src/a.ts` to do the thing.",
  "",
  "### Verification",
  "",
  "- The acceptance criterion is proved by `npm test`.",
  "",
  "### Out of Scope",
  "",
  "- Everything else.",
].join("\n")

/**
 * A session whose stage commands are no-ops and whose prompts are recorded —
 * along with whether a loop still owned the session when each prompt was sent,
 * which is the one ordering constraint the ask depends on.
 */
const makePlanClient = (files: Record<string, string>, onPrompt?: () => void, shellLog?: string[]) => {
  const { client, toasts } = makeClientFS(files)
  const commands: string[] = []
  const prompts: string[] = []
  const drivenAtPrompt: boolean[] = []
  /** How much shell work had happened when each prompt was sent — see the ordering assert. */
  const shellAtPrompt: number[] = []
  const withTurns = {
    ...client,
    session: {
      get: async () => ({ data: { parentID: undefined } }),
      abort: async () => ({ data: true }),
      command: async ({ body }: { body: { command: string } }) => {
        commands.push(body.command)
        return { data: { parts: [], info: undefined } }
      },
      prompt: async ({ body, path }: { body: { parts: { text?: string }[] }; path: { id: string } }) => {
        drivenAtPrompt.push(getWorkflow(path.id) !== undefined)
        shellAtPrompt.push(shellLog?.length ?? 0)
        prompts.push(body.parts.map((p) => p.text ?? "").join(""))
        onPrompt?.()
        return { data: undefined }
      },
    },
  } as unknown as Deps["client"]
  return { client: withTurns, commands, prompts, drivenAtPrompt, shellAtPrompt, toasts }
}

test("a plan the human asked for opens the approve/replan question when it parks", async () => {
  resetAskState()
  const sessionID = "sess-plan-parks"
  // The stage command is a no-op here, so the plan the PLAN stage would have
  // written is already on the file — what is under test is the park, not the author.
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: PLANNED_BODY }) }
  const log: string[] = []
  const { client, commands, prompts, drivenAtPrompt, shellAtPrompt } = makePlanClient(files, undefined, log)
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await planFromAgent(deps, sessionID, "my-task", testConfig)
  await onIdle(deps, sessionID, testConfig)

  assert.deepEqual(commands, ["plan-task"], "the PLAN stage must have run")
  assert.equal(prompts.length, 1, `expected exactly one gate turn, got ${JSON.stringify(prompts)}`)
  // The ordering constraint the whole thing rests on: the session must be free of
  // the drive, or the guards that stop a stage agent moving human gates refuse the
  // plugin's own ask. Two witnesses, because the loop state is cleared earlier than
  // the drive unwinds: no workflow registered, AND the drive's own teardown (the
  // stage-marker removal in `drive`'s finally) already ran. Fired from the park arm
  // — the tempting place — the second assert fails.
  assert.deepEqual(drivenAtPrompt, [false], "the ask must be sent after the loop released the session")
  const teardown = log.findIndex((cmd) => cmd.startsWith("rm -f") && cmd.includes(".stage"))
  assert.ok(teardown >= 0, `expected the drive's stage-marker teardown in the shell log: ${JSON.stringify(log.slice(-8))}`)
  assert.ok(teardown < shellAtPrompt[0]!, "the ask must be sent after the drive unwound, not from the park arm")
  assert.match(prompts[0]!, /Approve the plan for `my-task`/)
  assert.match(prompts[0]!, /question/, "only the model can open a window — the turn has to ask it to")
  // Every option must name the tool that executes it: this host has no MCP server
  // and guards writes under docs/tasks/, so "tell them to type the verb" is the
  // ask made pointless.
  assert.match(prompts[0]!, /workflow_gate/)
  assert.match(prompts[0]!, /workflow_replan/)
  clearWorkflow(sessionID)
})

/**
 * The boundary the whole design turns on. `watch`/`claim` drives are unattended by
 * definition — a dialog there stalls the loop on nobody — and they never come
 * through `claimForPlan`, which is where the flag is set.
 */
test("a watcher's plan parks silently, with no question for nobody", async () => {
  resetAskState()
  const sessionID = "sess-watch-parks"
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: PLANNED_BODY }) }
  const { client, commands, prompts } = makePlanClient(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, sessionID, "claim", testConfig)
  await onIdle(deps, sessionID, testConfig)

  assert.deepEqual(commands, ["plan-task"], "the claim must still have driven a PLAN pass")
  assert.deepEqual(prompts, [], "an unattended worker must not open a question")
  clearWorkflow(sessionID)
})

/**
 * A drive that did not park has nothing to ask about, and that is exactly why the
 * flag rides the work item instead of a module map: no cleanup path (ESC, stop,
 * a vetoed park) has to remember to disarm it.
 */
test("a PLAN pass that fails to park asks nothing", async () => {
  resetAskState()
  const sessionID = "sess-plan-vetoed"
  // No Implementation Plan on the file and a no-op stage: the park is refused.
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: "goal" }) }
  const { client, prompts } = makePlanClient(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await planFromAgent(deps, sessionID, "my-task", testConfig)
  await onIdle(deps, sessionID, testConfig)

  assert.deepEqual(prompts, [], "a plan that never landed must not be offered for approval")
  clearWorkflow(sessionID)
})

/**
 * The ask is best-effort by construction: it runs after a drive that already
 * SUCCEEDED, so a failure here costs the dialog, not the plan — which is parked
 * with the same toast as always. Throwing instead would surface a park as a loop
 * error and send the operator after a plan that is sitting exactly where it should.
 */
test("a gate turn that cannot be started is logged, never thrown", async () => {
  resetAskState()
  const sessionID = "sess-prompt-fails"
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: PLANNED_BODY }) }
  const { client } = makePlanClient(files, () => {
    throw new Error("session is busy")
  })
  const warnings: string[] = []
  const log: string[] = []
  const deps: Deps = {
    client,
    $: makeShellFS(files, log),
    directory: "/repo",
    log: (level, message) => void (level === "warn" && warnings.push(message)),
  }

  await planFromAgent(deps, sessionID, "my-task", testConfig)
  await onIdle(deps, sessionID, testConfig) // must resolve, not reject
  // The prompt is fired unawaited, so let its rejection settle before asserting.
  await new Promise((resolve) => setImmediate(resolve))

  const gateWarning = warnings.find((w) => w.includes("plan gate question"))
  assert.ok(gateWarning, `expected a warning naming the failure, got ${JSON.stringify(warnings)}`)
  assert.match(gateWarning, /my-task/)
  assert.match(gateWarning, /parked in plan-review/, "the operator has to be told the plan is fine")
  clearWorkflow(sessionID)
})

/**
 * `workflow_replan` exists because of the question above: an ask whose answer the
 * model cannot execute is worse than no ask, and Replan had no tool behind it.
 */
test("workflow_replan rejects the parked plan and re-plans it in the same turn", async () => {
  resetAskState()
  const sessionID = "sess-replan-tool"
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: PLANNED_BODY }) }
  const { client, prompts } = makePlanClient(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const out = await replanFromAgent(deps, sessionID, "my-task", "the rollout step is hand-waved", testConfig)

  assert.match(out, /re-planning now/, `unexpected: ${out}`)
  assert.ok(
    log.some((cmd) => cmd.includes("queued/my-task.md")),
    "the rejection must move the task back to queued/",
  )
  assert.deepEqual(prompts, [], "the chained PLAN pass runs on the next idle, not from this call")
  clearWorkflow(sessionID)
})

test("workflow_replan refuses a stage agent, and fails closed when it cannot tell", async () => {
  resetAskState()
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: PLANNED_BODY }) }
  const { client } = makePlanClient(files)
  const log: string[] = []
  const blind = { ...client, session: { get: async () => { throw new Error("session lookup failed") } } } as unknown as Deps["client"]
  const deps: Deps = { client: blind, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  assert.match(await replanFromAgent(deps, "sess-blind", "my-task", "why", testConfig), /refusing the gate move/)
  assert.ok(!log.some((cmd) => cmd.includes("mv")), "a refused rejection must move nothing")
})

test("/approve with no id ships the single in-review task to completed/", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed diff" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  // The fake shell's default (unmatched → exitCode 0, empty stdout) makes the
  // branch "exist" and the push "succeed", but every `gh` call reads as empty
  // output — i.e. attempted-but-failed, not "no branch". So this is the
  // caveated ship: it SHIPPED (the task moved), and the toast is a warning
  // rather than green so the note is not scrolled past. Not a failure — the
  // sibling test below pins that a no-branch ship stays "success".
  assert.equal(toasts[0]?.variant, "warning")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("completed")), "the ship still happened")
  assert.ok(log.some((cmd) => cmd.includes("PR not opened")))
  assert.ok(!(toasts[0]?.message ?? "").includes("PR:"))
  assert.match(toasts[0]?.message ?? "", /no PR was opened/)
})

test("ship is a silent no-op on PR creation when there's no feature/<id> branch", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed diff" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const overrides: ShellOverride[] = [{ cmd: "git -C /repo rev-parse --verify --quiet refs/heads/feature/my-task", result: { exitCode: 1 } }]
  const deps: Deps = { client, $: makeShellFS(files, log, overrides), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("completed")))
  assert.ok(!log.some((cmd) => cmd.includes("push")))
  assert.ok(!log.some((cmd) => cmd.includes("PR not opened") || cmd.includes("PR opened")))
  assert.equal(toasts[0]?.message, `"Ship it" completed.`)
})

test("ship pushes the branch and opens a draft PR when gh succeeds", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed diff" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const overrides: ShellOverride[] = [
    { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/feature/my-task", result: { exitCode: 0 } },
    { cmd: "git -C /repo push -u origin feature/my-task", result: { exitCode: 0 } },
    { cmd: "gh pr view feature/my-task", result: { exitCode: 1 } },
    { cmd: "gh repo view", result: { exitCode: 0, stdout: "main\n" } },
    { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/11\n" } },
  ]
  const deps: Deps = { client, $: makeShellFS(files, log, overrides), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.equal(toasts[0]?.message, `"Ship it" completed. PR: https://github.com/acme/widgets/pull/11`)
  assert.ok(log.some((cmd) => cmd.includes("PR opened") && cmd.includes("https://github.com/acme/widgets/pull/11")))
})

test("id-less approve falls back to a lone draft when no loop gate is waiting", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "no plan yet" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the lone draft is queued")
})

test("id-less approve skips the never-approve epic and queues the one real draft", async () => {
  const files = {
    "docs/tasks/draft/epic-a.md": serializeTask({ title: "Epic", body: "tracking", type: "epic" }),
    "docs/tasks/draft/task-b.md": serializeTask({ title: "B", body: "real work" }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("task-b") && cmd.includes("queued")))
  assert.ok(!log.some((cmd) => cmd.includes("epic-a") && cmd.includes("mv")), "the tracking epic is untouched")
})

test("id-less approve refuses to guess between two drafts, and asks which instead", async () => {
  const files = {
    "docs/tasks/draft/task-a.md": serializeTask({ title: "A", body: "x" }),
    "docs/tasks/draft/task-b.md": serializeTask({ title: "B", body: "y" }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const out = await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Multiple tasks awaiting/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move when ambiguous")
  // Refusing to guess is right; dead-ending there is not. The model gets the one
  // instruction it can act on — put the choice to the human — and `workflow_gate`
  // is the tool that can then honour the answer.
  assert.match(out, /NEXT STEP/)
  assert.match(out, /NOTHING has moved/)
  assert.match(out, /`task-a` — A \(draft\); `task-b` — B \(draft\)/)
  assert.match(out, /workflow_gate/)
})

// The tier-priority regression test: loop gates outrank the authoring gate, so a
// pile of drafts must never shadow (or make ambiguous) a single parked plan.
test("id-less approve ignores a draft and advances the single parked plan (not ambiguous)", async () => {
  const files = {
    "docs/tasks/draft/task-a.md": serializeTask({ title: "A", body: "x" }),
    "docs/tasks/plan-review/task-b.md": serializeTask({ title: "B", body: `${PLAN_HEADING}\n\n1. Step.` }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")), "the plan-review task advances")
  assert.ok(!log.some((cmd) => cmd.includes("task-a") && cmd.includes("mv")), "the draft is untouched")
})

test("id-less approve refuses to guess between two wait-gate tasks", async () => {
  const files = {
    "docs/tasks/plan-review/task-a.md": serializeTask({ title: "A", body: `${PLAN_HEADING}\n\n1. Step.` }),
    "docs/tasks/in-review/task-b.md": serializeTask({ title: "B", body: "reviewed" }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Multiple tasks awaiting/)
  assert.match(toasts[0]?.message ?? "", /task-a.*task-b/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move when ambiguous")
})

/**
 * The dead end this fixes, in its original shape: a slice set left a bare
 * `approve` with nothing to do but reprint "pass an id", so the human had to
 * type one per child. The candidates carry each slice's title and epic, which is
 * what makes the question answerable.
 */
test("a slice set's ambiguity offers the slices in approval order, naming their epic", async () => {
  const files = {
    "docs/tasks/draft/c3d4-ui.md": serializeTask({ title: "Wire the UI", epic: "k2p9-epic", priority: 1, body: "y" }),
    "docs/tasks/draft/a1b2-api.md": serializeTask({ title: "Add the API layer", epic: "k2p9-epic", priority: 0, body: "x" }),
    "docs/tasks/draft/k2p9-epic.md": serializeTask({ title: "The whole feature", type: "epic", body: "children…" }),
  }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const out = await handleApprove(deps, "sess", "", testConfig)

  assert.match(out, /`a1b2-api` — Add the API layer \(draft, slice of epic `k2p9-epic`\); `c3d4-ui` — Wire the UI/)
  assert.doesNotMatch(out, /k2p9-epic` — The whole feature/, "the tracking epic is never a candidate")
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")))
})

test("a task gate on a slice leaves a NEXT STEP naming the next un-approved one", async () => {
  const files = {
    "docs/tasks/draft/a1b2-api.md": serializeTask({ title: "Add the API layer", epic: "k2p9-epic", priority: 0, body: "x" }),
    "docs/tasks/draft/c3d4-ui.md": serializeTask({ title: "Wire the UI", epic: "k2p9-epic", priority: 1, body: "y" }),
  }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const out = await handleApprove(deps, "sess-walk", "a1b2-api", testConfig)

  assert.match(out, /Plan `a1b2-api` now\?/)
  assert.match(out, /1 slice still un-approved/)
  assert.match(out, /Approve `c3d4-ui` now\?/)
  assert.match(out, /Wire the UI/)
  // Only the "not yet" arm walks: on yes, workflow_plan owns the session and
  // there is no free model turn left to ask anything in.
  assert.match(out, /planning owns the rest of this turn/)
})

test("id-less approve with no candidates says nothing is awaiting approval", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /Nothing awaiting approval/)
})

test("id-less approve refuses a planless plan-review task and points at replan", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: "no plan heading" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /no Implementation Plan/)
  assert.match(toasts[0]?.message ?? "", /replan/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move for a planless task")
})

test("approve <id> advances that task by its folder's gate", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

test("approve <draft-id> queues the draft — the unified task gate", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the draft moves to queued/")
})

test("/approve <id> on an already-advanced task reports info, not error", async () => {
  const files = { "docs/tasks/completed/my-task.md": serializeTask({ title: "Done", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /completed/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move on an already-advanced task")
})

test("/reject with no id sends the single plan-review task back, whole arg as reason", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleReplan(deps, "sess-reject-noid", "the migration order is unsafe", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /re-planning now/)
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("the migration order is unsafe")))
})

test("/reject <id> [reason] captures the id and the trailing reason", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleReplan(deps, "sess-reject-id", "my-task misses the cache layer", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("misses the cache layer")))
})

test("/reject with no plan awaiting is a harmless info toast", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleReplan(deps, "sess", "some reason", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /No plan awaiting rejection/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move when nothing awaits")
})

test("/remove <id> --force hard-deletes the task file — rm, no mv", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleRemove(deps, "sess", "my-task --force", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /removed/)
  assert.ok(log.some((cmd) => cmd.startsWith("rm ")), "the file is deleted")
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "and never moved")
})

test("/remove <id> without --force deletes nothing and reports what it would delete", async () => {
  // handleRemove runs inside command.execute.before, so no model turn exists in
  // which to ask the user — the dry run IS the confirmation on this host.
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const outcome = await handleRemove(deps, "sess", "my-task", testConfig)

  assert.match(toasts[0]?.message ?? "", /--force/)
  assert.match(toasts[0]?.message ?? "", /Do the thing/, "names the task the id resolved to")
  assert.ok(!log.some((cmd) => cmd.startsWith("rm ")), "nothing deleted")
  // The dry run IS the confirmation, and the USER confirms off what the model
  // relays — so the outcome must ride back for the hook to put in the prompt.
  assert.equal(outcome, toasts[0]?.message, "remove returns exactly what it toasted")
})

test("/abandon <id> moves the task to abandoned/ — mv, no rm", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  const outcome = await handleAbandon(deps, "sess", "my-task superseded", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /abandoned/)
  // Report-and-stop: the outcome rides back to the command hook so it can
  // replace the rendered markdown — a toast alone is invisible to the model.
  assert.equal(outcome, toasts[0]?.message, "abandon returns exactly what it toasted")
  assert.ok(log.some((cmd) => cmd.startsWith("mv ") && cmd.includes("/abandoned/")), "the file moves to abandoned/")
  // Claim-stamp/worktree cleanup legitimately shells out to `rm -f`; what must
  // never happen is the TASK FILE being deleted the way remove deletes it.
  assert.ok(!log.some((cmd) => cmd.startsWith("rm ") && cmd.includes("my-task.md")), "the task file is never deleted")
})

test("/abandon with no id is a usage warning, not a move", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleAbandon(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Usage/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "nothing moved")
})

test("/remove with no id is a usage warning, not a delete", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleRemove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Usage/)
  assert.ok(!log.some((cmd) => cmd.startsWith("rm ")), "nothing deleted")
})

test("approve routes the gate move (subcommand, not top-level)", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

test("replan <why> routes the rejection, reason noted", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess-replan-why", "replan the migration order is unsafe", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("the migration order is unsafe")))
})

test("id-less approve ships the single in-review task (ship verb is gone)", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve", testConfig)

  // Warning, not success: same attempted-but-failed PR as the test above. The
  // ship itself landed, which is what the mv asserts.
  assert.equal(toasts[0]?.variant, "warning")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("completed")))
})


test("claim queues a one-shot pull scoped to the command's kind", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess-claim", "claim", testConfig)
  await handleCommand(deps, "sess-claim-pr", "claim", testConfig, "pr-sitter")

  assert.match(toasts[0]?.message ?? "", /Claiming the next engineering item/)
  assert.match(toasts[1]?.message ?? "", /Claiming the next pr-sitter item/)
})

test("engineering-only verbs on another kind's command get that kind's usage", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "new add rate limiting", testConfig, "pr-sitter")
  await handleCommand(deps, "sess", "approve my-task", testConfig, "pr-sitter")

  assert.equal(toasts.length, 2)
  for (const t of toasts) {
    assert.equal(t.variant, "warning")
    assert.match(t.message, /agentic-workflow:pr-sitter claim · watch/)
  }
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no gate move from a foreign kind command")
})

test("kinds lists known kinds with their enabled state", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "kinds", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /engineering \(enabled\)/)
  // Every sitter carries the experimental caveat next to its on/off state, so
  // the reader sees it where the kind is named rather than only in the docs.
  assert.match(toasts[0]?.message ?? "", /dep-sitter \(disabled, experimental\)/)
  assert.match(toasts[0]?.message ?? "", /pr-sitter \(disabled, experimental\)/)
  assert.match(toasts[0]?.message ?? "", /review-sitter \(disabled, experimental\)/)
  assert.match(toasts[0]?.message ?? "", /main-sitter \(disabled, experimental\)/)
})

test("report-and-stop verbs return their outcome for the command hook to surface", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  // A sitter verb: the toast is invisible to the model, so handleCommand must
  // hand the outcome back for the hook to override the rendered template with.
  const claimed = await handleCommand(deps, "sess", "claim", testConfig, "pr-sitter")
  const unwatched = await handleCommand(deps, "sess", "unwatch", testConfig, "pr-sitter")

  assert.equal(claimed, toasts[0]?.message, "claim returns exactly what it toasted")
  assert.match(claimed ?? "", /Claiming the next pr-sitter item/)
  assert.equal(unwatched, toasts[1]?.message, "unwatch returns exactly what it toasted")
  assert.match(unwatched ?? "", /watching/i)
})

test("authoring verbs return undefined so their command markdown reaches the model", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "x" })
  const files = { "docs/tasks/draft/my-task.md": draft }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  // new intentionally passes through: overriding it would strip the interview
  // turn the markdown drives.
  assert.equal(await handleCommand(deps, "sess", "new add rate limiting", testConfig), undefined)
})

test("approve is report-and-stop: it returns exactly what it toasted", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "x" })
  const files = { "docs/tasks/draft/my-task.md": draft }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  // Core self-verifies the gate move, so the outcome rides back to the command
  // hook to replace the rendered markdown — no model turn glob-verifies it.
  const outcome = await handleCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(outcome, toasts[0]?.message, "approve returns exactly what it toasted")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")), "the task gate move ran")
})

test("an unknown verb gets the engineering usage toast", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "no-such-verb", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Unknown \/agentic-workflow:engineering mode/)
})

test("a quoted verb dispatches like its unquoted self — parity with the $1 the template renders", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "'unwatch'", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /watching/i, "quoted 'unwatch' must dispatch, not fall to the usage toast")
})

test("a multi-word quoted first token is one unknown verb, matching how $1 renders it", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", '"new idea" x', testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Unknown \/agentic-workflow:engineering mode/)
})

test("plan <id> on a draft points at approve, no move", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "plan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /it's a draft — approve it first/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "plan never moves gate files")
})

test("plan <id> on a build-ready in-progress task points at claim/watch", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const files = { "docs/tasks/in-progress/my-task.md": planned }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "plan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /build-ready/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "plan never moves in-progress files")
})

test("id-less approve refuses to guess between two in-review tasks", async () => {
  const files = {
    "docs/tasks/in-review/task-a.md": serializeTask({ title: "A", body: "x" }),
    "docs/tasks/in-review/task-b.md": serializeTask({ title: "B", body: "y" }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Multiple tasks awaiting/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move when ambiguous")
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
  // channel the workflow_verdict tool uses, then returns the stage's text.
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

  const state: WorkflowState = {
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
 * The live-stage advertisement: drive writes `.stage-opencode.json` (the
 * OpenCode sibling of the Claude host's `.stage.json` — see core's
 * stage-marker.ts) before each stage fires, and its finally takes it down on
 * every exit, so the hub's driving oracle never sees a stale marker after a
 * clean drive.
 */
test("drive advertises the live stage in .stage-opencode.json and clears it on exit", async () => {
  const sessionID = "sess-oc-marker"
  const log: string[] = []
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
  const state: WorkflowState = { kind: "pr-sitter", goal: "Sit on PR #1", stage: "triage", iteration: 0, artifacts: {} }

  await drive(deps, sessionID, testConfig, firstStep(manifestFor("pr-sitter"), state))

  const markerFile = "/repo/docs/tasks/runs/.stage-opencode.json"
  const writeIdx = log.findIndex((cmd) => cmd.startsWith("printf '%s' ") && cmd.includes(markerFile))
  assert.ok(writeIdx >= 0, "no marker write in the command stream")
  const written = log[writeIdx]!
  assert.match(written, /"host":"opencode"/)
  assert.match(written, /"kind":"pr-sitter"/)
  assert.match(written, /"stage":"triage"/)
  const clearIdx = log.findIndex((cmd) => cmd === `rm -f ${markerFile}`)
  assert.ok(clearIdx > writeIdx, "marker not cleared after the drive")
})

/**
 * Per-stage model selection: a `workflows.<kind>.stageModels.<stage>` config entry
 * must ride the session.command body (the SDK's optional `model`), and an
 * unconfigured stage must send no `model` key at all — the host default is
 * "absent", not a hardcoded string.
 */
test("drive passes the configured stage model in the command body, and omits it when unconfigured", async () => {
  const runWith = async (sessionID: string, config: typeof testConfig) => {
    const bodies: Record<string, unknown>[] = []
    const client = {
      tui: { showToast: async () => ({ data: undefined }) },
      session: {
        command: async ({ body }: { body: Record<string, unknown> }) => {
          bodies.push(body)
          recordVerdict(sessionID, "triage", { verdict: "FAIL", reason: "nothing actionable" })
          return { data: { parts: [{ type: "text", text: "triaged: no actionable signal" }] } }
        },
      },
    } as unknown as Deps["client"]
    const deps: Deps = { client, $: makeShellFS({}, []), directory: "/repo", log: () => {} }
    const state: WorkflowState = { kind: "pr-sitter", goal: "Sit on PR #1", stage: "triage", iteration: 0, artifacts: {} }
    const outcome = await drive(deps, sessionID, config, firstStep(manifestFor("pr-sitter"), state))
    assert.equal(outcome?.kind, "done")
    return bodies
  }

  const configured = await runWith("sess-model-set", {
    ...testConfig,
    workflows: { "pr-sitter": { enabled: true, stageModels: { triage: "anthropic/claude-opus-4-5" } } },
  })
  assert.equal(configured[0]?.["model"], "anthropic/claude-opus-4-5")

  const unconfigured = await runWith("sess-model-unset", testConfig)
  assert.ok(!("model" in (unconfigured[0] ?? {})), "no model key when none is configured")
})

test("a timed-out stage aborts the orphaned session turn before unwinding", async () => {
  // The old timeout merely rejected the race: the orphaned turn kept running
  // server-side, editing files and invoking git WHILE onIdle's catch tore down
  // isolation in the same tree. The timeout must abort the turn and wait for
  // it to settle before the error unwinds.
  const sessionID = "sess-timeout-abort"
  const log: string[] = []
  const events: string[] = []
  let rejectCommand: ((e: Error) => void) | undefined
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: () =>
        new Promise((_, reject) => {
          rejectCommand = reject // never settles until aborted
        }),
      abort: async () => {
        events.push("abort")
        rejectCommand?.(new Error("aborted"))
        return { data: true }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }
  const state: WorkflowState = { kind: "pr-sitter", goal: "Sit on PR #1", stage: "triage", iteration: 0, artifacts: {} }
  try {
    await assert.rejects(
      () =>
        drive(
          deps,
          sessionID,
          { ...testConfig, stageTimeoutMinutes: 0.001 },
          firstStep(manifestFor("pr-sitter"), state),
        ),
      /timed out after/,
    )
    assert.deepEqual(events, ["abort"], "the orphaned turn was aborted exactly once")
  } finally {
    clearWorkflow(sessionID)
  }
})

test("a driver-initiated timeout abort is not treated as a user ESC", async () => {
  // The timeout's `session.abort` surfaces as the same MessageAbortedError a
  // human ESC does. onInterrupt must ignore it: before this, a stage timeout
  // was routed through the interrupt path, which killed watch mode (dropping
  // the clone's watch lease — the unattended watcher died on the most likely
  // failure of a long run) and toasted "Loop interrupted" for an interrupt
  // that never happened.
  const sessionID = "sess-timeout-not-esc"
  const toasts: string[] = []
  let rejectCommand: ((e: Error) => void) | undefined
  const client = {
    tui: {
      showToast: async ({ body }: { body: { message: string } }) => {
        toasts.push(body.message)
        return { data: undefined }
      },
    },
    session: {
      command: () =>
        new Promise((_, reject) => {
          rejectCommand = reject
        }),
      abort: async () => {
        rejectCommand?.(new Error("aborted"))
        return { data: true }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, []), directory: "/repo", log: () => {} }
  const state: WorkflowState = { kind: "pr-sitter", goal: "Sit on PR #1", stage: "triage", iteration: 0, artifacts: {} }
  try {
    await assert.rejects(
      () => drive(deps, sessionID, { ...testConfig, stageTimeoutMinutes: 0.001 }, firstStep(manifestFor("pr-sitter"), state)),
      /timed out after/,
    )
    // The abort event lands after the drive unwound — the workflow is still set
    // (onIdle's catch owns clearing it in prod), so an un-suppressed interrupt
    // would flag the session and toast "Loop interrupted".
    await onInterrupt(deps, sessionID)
    assert.ok(!toasts.some((t) => /interrupted/i.test(t)), `the timeout abort must not read as a user interrupt: ${toasts.join(" | ")}`)
  } finally {
    clearWorkflow(sessionID)
  }
})

/**
 * Activity instrumentation: the response's tool parts are aggregated per tool
 * (count + errors) and the files write-tools touched are collected — the "what
 * did the agent DO" signal the captured text can't answer.
 */
test("deriveActivity aggregates tool calls and collects written files", () => {
  const activity = deriveActivity([
    { type: "text", text: "ignored" },
    { type: "tool", tool: "bash", state: { status: "completed" } },
    { type: "tool", tool: "bash", state: { status: "error" } },
    { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts" } } },
    { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts" } } },
    { type: "tool", tool: "write", state: { status: "completed", input: { path: "src/b.ts" } } },
    { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/never.ts" } } },
  ])
  // bash first (highest count), then edit, then write/read tie broken by name.
  assert.deepEqual(activity?.tools, [
    { tool: "bash", count: 2, errors: 1 },
    { tool: "edit", count: 2, errors: 0 },
    { tool: "read", count: 1, errors: 0 },
    { tool: "write", count: 1, errors: 0 },
  ])
  // read is not a write tool — its path is NOT collected; edit dedups a.ts.
  assert.deepEqual(activity?.files, ["src/a.ts", "src/b.ts"])
})

test("deriveActivity returns undefined when no tool parts are present", () => {
  assert.equal(deriveActivity([{ type: "text", text: "just text" }]), undefined)
  assert.equal(deriveActivity([]), undefined)
})

/**
 * Token instrumentation: the assistant message's usage totals (tokens/cost/
 * model) must land in the run metrics — the summary table gains token/cost
 * columns and the structured sidecar (`runs/<id>.metrics.json`) records the
 * samples with the driving sessionID for exact host-storage joins.
 */
test("drive records stage token usage into the run summary and metrics sidecar", async () => {
  const sessionID = "sess-tokens"
  const log: string[] = []
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        recordVerdict(sessionID, "triage", { verdict: "FAIL", reason: "nothing actionable" })
        return {
          data: {
            info: {
              tokens: { input: 10_000, output: 1_800, reasoning: 200, cache: { read: 90_000, write: 2_000 } },
              cost: 0.1234,
              modelID: "claude-sonnet-5",
            },
            parts: [
              { type: "text", text: "triaged: nothing to do" },
              { type: "tool", tool: "bash", state: { status: "completed" } },
              { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/x.ts" } } },
            ],
          },
        }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  const state: WorkflowState = {
    kind: "pr-sitter",
    goal: "Sit on PR #2",
    stage: "triage",
    iteration: 0,
    artifacts: {},
  }

  const outcome = await drive(deps, sessionID, testConfig, firstStep(manifestFor("pr-sitter"), state))
  assert.equal(outcome?.kind, "done")

  const summaryWrite = log.find((c) => c.startsWith("printf") && c.includes("Run summary"))
  assert.ok(summaryWrite, "run summary was appended")
  assert.match(summaryWrite ?? "", /102\.0k\/2\.0k/)
  assert.match(summaryWrite ?? "", /\$0\.1234/)

  const sidecarWrite = log.find((c) => c.startsWith("printf") && c.includes(".metrics.json"))
  assert.ok(sidecarWrite, "metrics sidecar was written")
  assert.match(sidecarWrite ?? "", /"host": "opencode"/)
  assert.match(sidecarWrite ?? "", /"sessionID": "sess-tokens"/)
  assert.match(sidecarWrite ?? "", /"input": 10000/)
  assert.match(sidecarWrite ?? "", /"model": "claude-sonnet-5"/)
  // Per-stage tool/file activity landed alongside the tokens.
  assert.match(sidecarWrite ?? "", /"tool": "bash"/)
  assert.match(sidecarWrite ?? "", /"tool": "edit"/)
  assert.match(sidecarWrite ?? "", /"files"/)
  assert.match(sidecarWrite ?? "", /src\/x\.ts/)
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

  const state: WorkflowState = {
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

// --- resolveDrivingSession: verdicts from subtask (child) sessions ---
// Check stages run as subtasks, so workflow_verdict arrives with the child
// session's id; unresolved, the verdict was silently ignored and the stage
// read "none recorded → FAIL" while the verifier's prose said PASS.

test("resolveDrivingSession walks the parentID chain to the driving session", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow("parent-sess", { goal: "g", stage: "verify", iteration: 0, artifacts: {} })
  const client = {
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) =>
        id === "child-sess" ? { data: { parentID: "parent-sess" } } : { data: {} },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  try {
    assert.equal(await resolveDrivingSession(client, "child-sess"), "parent-sess", "child resolves to its driving parent")
    assert.equal(await resolveDrivingSession(client, "parent-sess"), "parent-sess", "the driving session resolves to itself")
    assert.equal(await resolveDrivingSession(client, "stranger"), "stranger", "an unrelated session falls back to itself")
  } finally {
    clearWorkflow("parent-sess")
  }
})

test("findDrivingWorkflow returns the driving ancestor's state, null at root, and throws on API failure", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const state: WorkflowState = { goal: "g", stage: "build", iteration: 0, artifacts: {} }
  setWorkflow("drv", state)
  const client = {
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        if (id === "kid") return { data: { parentID: "drv" } }
        if (id === "broken") throw new Error("session API down")
        return { data: {} }
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  try {
    assert.deepEqual(await findDrivingWorkflow(client, "kid"), { sessionID: "drv", state }, "child resolves to its driving ancestor")
    assert.equal(await findDrivingWorkflow(client, "stranger"), null, "a chain ending with no loop resolves to null")
    // The strict core THROWS on a session-API failure so the worktree guard can
    // fail closed — the lenient resolveDrivingSession wrapper keeps falling back.
    await assert.rejects(() => findDrivingWorkflow(client, "broken"), /session API down/)
    assert.equal(await resolveDrivingSession(client, "broken"), "broken", "lenient wrapper falls back to the input id")
  } finally {
    clearWorkflow("drv")
  }
})

test("recordVerdict accepts the verdict once the child session is resolved to the driver", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow("drv-sess", { goal: "g", stage: "verify", iteration: 0, artifacts: {} })
  try {
    // Unresolved child id: ignored (the pre-fix behavior the resolver exists to prevent).
    assert.match(recordVerdict("some-child", "verify", { verdict: "PASS" }).message, /No active loop/)
    // Resolved driving id: recorded.
    assert.match(recordVerdict("drv-sess", "verify", worked("drv-sess", { verdict: "PASS" })).message, /Recorded verify verdict: PASS/)
  } finally {
    clearWorkflow("drv-sess")
  }
})

// --- stage drift: an out-of-stage verdict is rejected AND audited on the task ---

test("recordVerdict audits an out-of-stage verdict on the task file, once per stage attempt", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const shellLog: string[] = []
  const task = { id: "drift-task", path: "/repo/docs/tasks/in-progress/drift-task.md", acceptance: [] }
  // The task file has to EXIST for a note to land on it — `appendNote` refuses to
  // `>>` a path that is gone rather than recreating the task as a ghost.
  const deps: Deps = {
    client: makeClient().client,
    $: makeShellFS({ "/repo/docs/tasks/in-progress/drift-task.md": "---\ntitle: Drift\n---\n\nbody" }, shellLog),
    directory: "/repo",
    log: () => {},
  }
  setWorkflow("drv-drift", { goal: "g", stage: "build", iteration: 0, artifacts: {}, task })
  try {
    // A build stage that verified its own work: rejected, as before.
    assert.match(recordVerdict("drv-drift", "verify", { verdict: "PASS" }, deps).message, /loop is at build, not verify/)
    // ...and now audited, so the drift is visible in the trail rather than
    // surfacing one stage later as a re-run check or a fabricated PASS.
    await new Promise((r) => setTimeout(r, 20)) // the note is appended fire-and-forget
    const noted = shellLog.filter((cmd) => cmd.includes("Stage drift"))
    assert.equal(noted.length, 1, "the drift is audited")
    assert.match(noted[0]!, /VERIFY/)
    assert.match(noted[0]!, /BUILD/)
    // A drifting stage usually calls more than once (verify, then review) —
    // the task file must not collect a note per call.
    recordVerdict("drv-drift", "review", { verdict: "PASS" }, deps)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(shellLog.filter((cmd) => cmd.includes("Stage drift")).length, 1, "one note per stage attempt")
  } finally {
    clearWorkflow("drv-drift")
  }
})

test("recordVerdict still records a verdict from the stage the loop is actually at", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const shellLog: string[] = []
  const deps: Deps = { client: makeClient().client, $: makeShellFS({}, shellLog), directory: "/repo", log: () => {} }
  const task = { id: "ok-task", path: "/repo/docs/tasks/in-progress/ok-task.md", acceptance: [] }
  setWorkflow("drv-ok", { goal: "g", stage: "verify", iteration: 0, artifacts: {}, task })
  try {
    assert.match(recordVerdict("drv-ok", "verify", worked("drv-ok", { verdict: "PASS" }), deps).message, /Recorded verify verdict: PASS/)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(shellLog.filter((cmd) => cmd.includes("Stage drift")).length, 0, "no drift note on the happy path")
  } finally {
    clearWorkflow("drv-ok")
  }
})

// --- runStagePasses: a missing lens verdict is a broken channel, not a FAIL ---
// Regression guard for the spurious-second-iteration bug: with reviewLenses
// configured, a lens whose workflow_verdict call never lands used to combine as
// null→FAIL (worstOf) and fire a rebuild of already-passing work; it must take
// the same ERROR→recoverable-stop path as the single-pass case.

const lensConfig: Config = { ...testConfig, reviewLenses: ["correctness", "security"] }

/** Run the review stage with two lenses; `onCall(n, deps)` runs before the nth stage command returns. */
const runLensReview = async (
  sessionID: string,
  onCall: (call: number, deps: Deps) => void,
  warns: string[] = [],
  cfg: Config = lensConfig,
) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  let calls = 0
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        calls++
        onCall(calls, deps)
        return { data: { parts: [{ type: "text", text: `review pass ${calls}` }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = {
    client,
    $: makeShellFS({}, []),
    directory: "/repo",
    log: (level, msg) => {
      if (level === "warn") warns.push(msg)
    },
  }
  try {
    const result = await runStagePasses(
      deps,
      sessionID,
      cfg,
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
    return { result, calls: () => calls }
  } finally {
    clearWorkflow(sessionID)
  }
}

// --- required axes: the review stage's verdict must cover all five ---

const FIVE = ["correctness", "readability", "architecture", "security", "performance"]
const cleanAxes = FIVE.map((axis) => ({ axis, verdict: "PASS" as const }))

/**
 * A check pass that actually did its work: the guard observed a command, and the
 * verdict cites it.
 *
 * Engineering verify/review declare `requireEvidence`, so a PASS backed by
 * neither is REJECTED — that is the proof-of-work gate working
 * (@agentic-workflow/core/workflow/evidence), not a fixture detail. Every test
 * below that wants a PASS to LAND has to say what the pass did; the ones
 * asserting a rejection deliberately do not.
 */
const worked = <T extends { verdict: "PASS" | "FAIL" | "ERROR" }>(sessionID: string, record: T) => {
  noteEvidence(sessionID, { command: "npm test" })
  return { ...record, evidence: [{ kind: "command" as const, ref: "npm test", result: "42 passed" }] }
}

/** Run the review stage as ONE pass (no lenses), so axis coverage is enforced. */
const runSinglePassReview = async (sessionID: string, onCall: (deps: Deps) => void) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        onCall(deps)
        return { data: { parts: [{ type: "text", text: "review pass" }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, []), directory: "/repo", log: () => {} }
  try {
    return await runStagePasses(
      deps,
      sessionID,
      testConfig,
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
  } finally {
    clearWorkflow(sessionID)
  }
}

test("a fan-out stage refreshes the stage-marker deadline and claim stamp per pass", async () => {
  // `staleClaimMinutes` and the marker deadline budget ONE stage timeout, but a
  // fan-out check stage legitimately runs passes × attempts × timeout. Without
  // a per-pass refresh a live REVIEW reads dead to doctor/recover mid-fan-out
  // and its claim is stolen while lens 2 of N is still running.
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const sessionID = "sess-per-pass-restamp"
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const shellLog: string[] = []
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
        return { data: { parts: [{ type: "text", text: "review pass" }] } }
      },
    },
  } as unknown as Deps["client"]
  // The claim marker must actually be HELD for a restamp to be observable —
  // `restampMarker` no-ops on an absent marker so it can never resurrect a
  // released claim, which is exactly what this test would otherwise measure.
  const deps: Deps = {
    client,
    $: makeShellFS({ "docs/tasks/in-progress/.claims/t/claim.json": JSON.stringify({ claimedAt: new Date().toISOString() }) }, shellLog),
    directory: "/repo",
    log: () => {},
  }
  try {
    await runStagePasses(
      deps,
      sessionID,
      lensConfig,
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
  } finally {
    clearWorkflow(sessionID)
  }
  const markerWrites = shellLog.filter((c) => c.startsWith("printf '%s' ") && c.includes(".stage-opencode.json"))
  assert.equal(markerWrites.length, 2, `one fresh deadline per pass, got ${markerWrites.length}`)
  const restamps = shellLog.filter((c) => c.startsWith("printf '%s' ") && c.includes(".claims/t/claim.json"))
  assert.equal(restamps.length, 2, `one claim restamp per pass, got ${restamps.length}`)
})

test("review: a verdict missing axes is rejected and records nothing", async () => {
  const sessionID = "sess-axes-missing"
  const rejections: string[] = []
  const result = await runSinglePassReview(sessionID, () => {
    const r = recordVerdict(sessionID, "review", {
      verdict: "PASS",
      axes: [{ axis: "correctness", verdict: "PASS" }],
    })
    if (!r.accepted) rejections.push(r.message)
  })
  assert.ok(rejections.length, "the incomplete call was rejected")
  assert.match(rejections[0]!, /Missing: readability, architecture, security, performance/)
  // Nothing was recorded, so the stage takes the broken-channel ERROR path
  // rather than shipping a one-axis review as a PASS.
  assert.equal(result.verdict, "ERROR")
})

test("review: a rejected call cannot clobber a complete verdict recorded earlier in the pass", async () => {
  const sessionID = "sess-axes-clobber"
  const result = await runSinglePassReview(sessionID, () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
    recordVerdict(sessionID, "review", { verdict: "FAIL", axes: [{ axis: "security", verdict: "FAIL" }] })
  })
  assert.equal(result.verdict, "PASS", "the good record survived the rejected one")
})

test("review: a later PASS cannot replace a FAIL recorded earlier in the same pass", async () => {
  // recordVerdict used to overwrite, so an agent that recorded FAIL and then
  // corrected itself to PASS had the PASS win. Repeat calls now combine
  // worst-wins, matching the Claude host.
  const sessionID = "sess-axes-downgrade"
  const result = await runSinglePassReview(sessionID, () => {
    recordVerdict(sessionID, "review", {
      verdict: "FAIL",
      axes: cleanAxes.map((a) =>
        a.axis === "security" ? { ...a, verdict: "FAIL" as const, findings: [{ severity: "critical" as const, detail: "sql hole" }] } : a,
      ),
    })
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
  })
  assert.equal(result.verdict, "FAIL")
})

test("review: a complete five-axis verdict is accepted", async () => {
  const sessionID = "sess-axes-complete"
  const result = await runSinglePassReview(sessionID, () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
  })
  assert.equal(result.verdict, "PASS")
})

// --- driver-run checks: exit codes are established fact, not a self-report ---

/** Run the review stage as one pass with `checks` already recorded for it. */
const runReviewWithChecks = async (sessionID: string, checks: CheckResult[], onCall: (deps: Deps) => void) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async () => {
        onCall(deps)
        return { data: { parts: [{ type: "text", text: "review pass" }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, []), directory: "/repo", log: () => {} }
  try {
    return await runStagePasses(
      deps,
      sessionID,
      testConfig,
      manifestFor("engineering"),
      {
        kind: "engineering",
        goal: "g",
        stage: "review",
        iteration: 0,
        artifacts: {},
        checks: { review: checks },
        task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] },
      },
      "review",
      "goal args",
      0,
    )
  } finally {
    clearWorkflow(sessionID)
  }
}

const checkResult = (over: Partial<CheckResult> = {}): CheckResult => ({
  name: "tests",
  command: "npm test",
  exitCode: 0,
  outcome: "pass",
  output: "",
  ...over,
})

test("checks: a red one floors an agent's clean PASS to FAIL", async () => {
  // The point of the whole feature — the stage can no longer talk past an exit
  // code, because the floor goes through the same derivation as a Critical axis.
  const sessionID = "sess-checks-red"
  const result = await runReviewWithChecks(sessionID, [checkResult({ outcome: "fail", exitCode: 1, output: "2 failing" })], () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
  })
  assert.equal(result.verdict, "FAIL")
  assert.equal(result.record?.verdict, "PASS", "the DECLARED verdict is preserved; only the derived one moves")
  assert.match(JSON.stringify(result.record?.axes), /2 failing/)
})

test("checks: a 127 is ERROR, not FAIL — a missing runner must not burn an iteration", async () => {
  const sessionID = "sess-checks-missing"
  const result = await runReviewWithChecks(sessionID, [checkResult({ outcome: "error", exitCode: 127 })], () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
  })
  assert.equal(result.verdict, "ERROR")
})

test("checks: all green leaves the recorded verdict exactly as the agent recorded it", async () => {
  const sessionID = "sess-checks-green"
  const result = await runReviewWithChecks(sessionID, [checkResult()], () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: cleanAxes }))
  })
  assert.equal(result.verdict, "PASS")
  assert.equal(result.record?.axes?.length, cleanAxes.length, "no synthetic axis was added to a green run")
})

test("checks: the driver's commands count as observed evidence for the pass", async () => {
  // Without the seed this is the regression the feature would otherwise ship: the
  // prompt tells the stage the results are fact and not to re-run them, so the
  // stage does nothing observable, `evidenceIssue` rejects its PASS as
  // unsubstantiated, and a no-verdict stage is recorded as FAIL — on a suite
  // that was green. Note this pass never calls `noteEvidence` itself.
  const sessionID = "sess-checks-evidence"
  const rejections: string[] = []
  const result = await runReviewWithChecks(sessionID, [checkResult()], () => {
    const r = recordVerdict(sessionID, "review", {
      verdict: "PASS",
      axes: cleanAxes,
      evidence: [{ kind: "command", ref: "npm test", result: "42 passed" }],
    })
    if (!r.accepted) rejections.push(r.message)
  })
  assert.deepEqual(rejections, [], "the citation was corroborated by what the driver ran")
  assert.equal(result.verdict, "PASS")
})

test("review: a declared PASS carrying a Critical finding lands as FAIL", async () => {
  const sessionID = "sess-axes-lying"
  const result = await runSinglePassReview(sessionID, () => {
    recordVerdict(sessionID, "review", {
      verdict: "PASS",
      axes: cleanAxes.map((a) =>
        a.axis === "security" ? { ...a, findings: [{ severity: "critical" as const, detail: "secret logged" }] } : a,
      ),
    })
  })
  assert.equal(result.verdict, "FAIL")
})

test("review: a FAIL naming no blocking finding is rejected", async () => {
  const sessionID = "sess-axes-empty-fail"
  const rejections: string[] = []
  await runSinglePassReview(sessionID, () => {
    const r = recordVerdict(sessionID, "review", { verdict: "FAIL", reason: "vibes", axes: cleanAxes })
    if (!r.accepted) rejections.push(r.message)
  })
  assert.ok(rejections.length)
  assert.match(rejections[0]!, /critical.*important/s)
})

// --- a twice-rejected verdict: the stage is routed on what it declared ---
//
// The regression: a review that FAILED had its call refused for its SHAPE, the
// pass was re-run, the second refusal left the stage with no record — and a
// record-less check stage ERRORs, so `review.onError` stopped the run and the
// findings never reached the BUILD they were for. What the user saw was "another
// REVIEW runs, and then we never go back to BUILD".

/** Run a single-pass review capturing the arguments of every fired pass. */
const runReviewCapturingArgs = async (sessionID: string, onCall: (call: number) => void, warns: string[] = []) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const fired: string[] = []
  let calls = 0
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async (req: { body: { arguments: string } }) => {
        calls++
        fired.push(req.body.arguments)
        onCall(calls)
        return { data: { parts: [{ type: "text", text: `review pass ${calls}` }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = {
    client,
    $: makeShellFS({}, []),
    directory: "/repo",
    log: (level, msg) => {
      if (level === "warn") warns.push(msg)
    },
  }
  try {
    const result = await runStagePasses(
      deps,
      sessionID,
      testConfig,
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
    return { result, fired }
  } finally {
    clearWorkflow(sessionID)
  }
}

test("review: a FAIL rejected twice lands as the stage's FAIL, so the loop re-builds", async () => {
  const sessionID = "sess-rejected-fail-twice"
  const warns: string[] = []
  const { result, fired } = await runReviewCapturingArgs(
    sessionID,
    () => {
      // Every attempt insists on the same unadmittable shape: a FAIL naming
      // nothing blocking. The review DID report — twice — so the stage fails.
      recordVerdict(sessionID, "review", { verdict: "FAIL", reason: "the retry logic is wrong", axes: cleanAxes })
    },
    warns,
  )
  assert.equal(fired.length, 2, "the pass still gets its one retry before the fallback")
  assert.equal(result.verdict, "FAIL", "FAIL — not ERROR — is what re-fires BUILD via review.onFail")
  assert.match(result.record?.reason ?? "", /the retry logic is wrong/, "the review's own reason reaches the next BUILD")
  assert.match(result.record?.reason ?? "", /rejected twice/)
  assert.ok(
    warns.some((w) => /rejected twice/.test(w)),
    `the salvage is logged: ${warns.join(" | ")}`,
  )
})

test("review: the retry after a REJECTED verdict quotes the rejection, not 'you recorded nothing'", async () => {
  const sessionID = "sess-rejected-retry-prompt"
  const { fired } = await runReviewCapturingArgs(sessionID, () => {
    recordVerdict(sessionID, "review", { verdict: "FAIL", reason: "vibes", axes: cleanAxes })
  })
  assert.doesNotMatch(fired[0]!, /PREVIOUS ATTEMPT/, "the first pass gets a clean prompt")
  assert.match(fired[1]!, /VERDICT WAS REJECTED/)
  assert.match(fired[1]!, /critical.*important/s, "the actual refusal is what makes the next call land")
  assert.doesNotMatch(fired[1]!, /RECORDED NO VERDICT/, "it did record one — the shape was refused")
})

test("review: an unearned PASS rejected twice still ERRORs, and stops blaming the plugin wiring", async () => {
  const sessionID = "sess-rejected-pass-twice"
  const { result } = await runReviewCapturingArgs(sessionID, () => {
    // A PASS with no evidence: `requireEvidence` refuses it, and no fallback may
    // launder it into a shipped review.
    recordVerdict(sessionID, "review", { verdict: "PASS", axes: cleanAxes })
  })
  assert.equal(result.verdict, "ERROR")
  assert.match(result.record?.reason ?? "", /every verdict offered was rejected/)
  assert.doesNotMatch(result.record?.reason ?? "", /plugin wiring/)
})

test("review: a stage that recorded nothing at all keeps the unreachable-channel ERROR", async () => {
  const sessionID = "sess-silent-channel"
  const { result } = await runReviewCapturingArgs(sessionID, () => {
    /* the subagent never calls workflow_verdict */
  })
  assert.equal(result.verdict, "ERROR")
  assert.match(result.record?.reason ?? "", /channel is unreachable/)
  assert.match(result.record?.reason ?? "", /plugin wiring/)
})

test("lens mode suppresses axis enforcement — a lens pass records its own focus only", async () => {
  // Each lens is told to focus exclusively on its own lens; demanding all five
  // axes from it would reject every pass and wedge the loop.
  const sessionID = "sess-axes-lens"
  const { result } = await runLensReview(sessionID, () => {
    const r = recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS" }))
    assert.ok(r.accepted, "an axis-less lens verdict is accepted")
  })
  assert.equal(result.verdict, "PASS")
})

test("lenses: axes merge across passes worst-wins, including a PASSing lens's evidence", async () => {
  const sessionID = "sess-axes-lens-merge"
  const { result } = await runLensReview(sessionID, (call) => {
    recordVerdict(
      sessionID,
      "review",
      call === 1
        ? worked(sessionID, {
            verdict: "PASS",
            axes: [{ axis: "security", verdict: "PASS", findings: [{ severity: "suggestion", detail: "lens A context" }] }],
          })
        : { verdict: "FAIL", axes: [{ axis: "security", verdict: "FAIL", findings: [{ severity: "critical", detail: "lens B hole" }] }] },
    )
  })
  assert.equal(result.verdict, "FAIL")
  const security = result.record?.axes?.find((a) => a.axis === "security")
  assert.equal(security?.verdict, "FAIL")
  assert.equal(security?.findings?.length, 2, "the PASSing lens's finding survived alongside the failing one")
})

test("lenses: both PASS combines to PASS", async () => {
  const sessionID = "sess-lens-pass"
  const { result, calls } = await runLensReview(sessionID, () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS" }))
  })
  assert.equal(result.verdict, "PASS")
  assert.equal(calls(), 2)
})

test("lenses: an ESC interrupt during lens 1 fires no further lens and no verdict retry", async () => {
  // `onInterrupt` deliberately KEEPS getWorkflow set (onIdle's catch needs it on a
  // reject-on-abort) and signals through the separate `interrupted` set. Both
  // halt checks here tested only getWorkflow, so after the user pressed ESC the
  // driver still fired the verdict retry for lens 1 AND both passes of lens 2 —
  // up to 3 more agent turns the user had just asked to stop.
  const sessionID = "sess-lens-interrupt"
  const { result, calls } = await runLensReview(sessionID, (call, deps) => {
    // Record no verdict: without the interrupt this pass alone would retry.
    if (call === 1) void onInterrupt(deps, sessionID)
  })
  assert.equal(calls(), 1, "no further agent turns after ESC")
  // A halted run returns quietly — never through the ERROR path, which would
  // report an unreachable verdict channel for a stage the user simply stopped.
  assert.equal(result.verdict, null)
  assert.equal(result.record, null)
})

test("lenses: one lens never records a verdict → ERROR naming the lens, never FAIL", async () => {
  const sessionID = "sess-lens-missing"
  const { result, calls } = await runLensReview(sessionID, (call) => {
    if (call === 1) recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS" }))
    // calls 2 and 3 (the security lens and its retry): no verdict recorded
  })
  assert.equal(result.verdict, "ERROR", "a broken lens verdict channel must stop, not rebuild")
  assert.match(result.record?.reason ?? "", /security/)
  assert.equal(calls(), 3, "1 correctness pass + security pass and its one retry")
})

/**
 * Lenses that between them name every required axis put the stage-wide coverage
 * check back on — `reviewLenses` used to switch it off unconditionally, which is
 * what made `requiredAxes` stop being required at EVERY level at once. The
 * condition is the lens list itself, so there is no new knob to opt in with, and
 * a lens set that cannot span the axes (the two-lens config every other test
 * here uses) keeps today's documented trade-off untouched.
 */
const spanningLensConfig: Config = { ...testConfig, reviewLenses: FIVE }

test("lenses spanning the required axes: a gap in the ACCUMULATED record stops with ERROR", async () => {
  const sessionID = "sess-lens-span-gap"
  // Every lens reports only `correctness`, so four required axes never reported
  // anywhere across the stage — a review that did not happen, not a FAIL to
  // rebuild on.
  const { result } = await runLensReview(
    sessionID,
    () => {
      recordVerdict(
        sessionID,
        "review",
        worked(sessionID, { verdict: "PASS", axes: [{ axis: "correctness", verdict: "PASS" as const }] }),
      )
    },
    [],
    spanningLensConfig,
  )
  assert.equal(result.verdict, "ERROR")
  for (const axis of ["readability", "architecture", "security", "performance"]) {
    assert.match(result.record?.reason ?? "", new RegExp(axis))
  }
})

test("lenses spanning the required axes: full coverage across the passes still PASSes", async () => {
  const sessionID = "sess-lens-span-ok"
  // Each lens reports its own axis; the union is complete, so the gate is silent.
  const { result, calls } = await runLensReview(
    sessionID,
    (call) => {
      const axis = FIVE[call - 1]!
      recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: [{ axis, verdict: "PASS" as const }] }))
    },
    [],
    spanningLensConfig,
  )
  assert.equal(calls(), 5, "one pass per lens")
  assert.equal(result.verdict, "PASS")
  assert.equal(result.record?.axes?.length, 5, "the axes merged across the passes")
})

test("lenses that do NOT span the axes are not gated — the documented trade-off is untouched", async () => {
  const sessionID = "sess-lens-nospan"
  // `["correctness", "security"]` can never report readability/architecture/
  // performance, so demanding them would ERROR every run. An axis-less lens
  // verdict is still accepted, exactly as before.
  const { result } = await runLensReview(sessionID, () => {
    recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS" }))
  })
  assert.equal(result.verdict, "PASS")
})

test("lenses: a genuine lens FAIL combines worst-wins with the lens-prefixed reason", async () => {
  const sessionID = "sess-lens-fail"
  const { result } = await runLensReview(sessionID, (call) => {
    recordVerdict(
      sessionID,
      "review",
      call === 1 ? worked(sessionID, { verdict: "PASS" }) : { verdict: "FAIL", reason: "auth bypass in handler" },
    )
  })
  assert.equal(result.verdict, "FAIL")
  assert.match(result.record?.reason ?? "", /\[security\] auth bypass in handler/)
})

test("lenses: a genuine FAIL plus a missing lens still stops with ERROR (no rebuild on partial information)", async () => {
  const sessionID = "sess-lens-fail-missing"
  const { result } = await runLensReview(sessionID, (call) => {
    if (call === 1) recordVerdict(sessionID, "review", { verdict: "FAIL", reason: "bug" })
  })
  assert.equal(result.verdict, "ERROR")
  assert.match(result.record?.reason ?? "", /security/)
})

test("lenses: a stop mid-pass returns quietly — no ERROR, no retry, no warn", async () => {
  const sessionID = "sess-lens-stop"
  const warns: string[] = []
  const { clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const { result, calls } = await runLensReview(
    sessionID,
    () => {
      clearWorkflow(sessionID) // a user `stop` lands while the first lens runs
    },
    warns,
  )
  assert.equal(result.verdict, null)
  assert.equal(result.record, null)
  assert.equal(calls(), 1, "no retry and no further lens passes after a stop")
  assert.ok(!warns.some((w) => /stopping with ERROR/.test(w)), `unexpected warn: ${warns.join(" | ")}`)
})

// --- per-axis fan-out: one focused pass per required axis ---
// The point of fan-out over lenses: each pass is enforced against its OWN axis
// (so a focused call is admitted, not rejected for the four it was told to skip)
// and the union restores the coverage lens mode gives up entirely.

const axisConfig: Config = {
  ...testConfig,
  workflows: { engineering: { stageFanout: { review: "axis" } } },
}

/** Run the review stage fanned out over its five axes; `onCall(n, deps)` runs before the nth command returns. */
/**
 * The same five-axis fan-out, run concurrently.
 *
 * `onCall` receives the pass's OWN session id — the thing concurrency turns on:
 * every per-pass table (`recordedVerdicts`, `axisRequirement`,
 * `observedEvidence`) is keyed by session, so a pass recording a verdict has to
 * record it against its own session or it lands on a sibling.
 *
 * Each command blocks until `release()` is called, so a test can hold every pass
 * open at once and prove they really overlap rather than inferring it from a
 * call count a sequential loop would also produce.
 */
const runConcurrentAxisReview = async (
  sessionID: string,
  // `null` sets no stageConcurrency at all — the fan-out's own default, which is
  // the path a user who only turned `stageFanout` on actually takes.
  concurrency: number | null,
  onCall: (passSessionID: string, focus: string, deps: Deps) => void,
  opts: { warns?: string[]; hold?: boolean } = {},
) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const config: Config = {
    ...testConfig,
    workflows: {
      engineering: {
        stageFanout: { review: "axis" },
        ...(concurrency === null ? {} : { stageConcurrency: { review: concurrency } }),
      },
    },
  }
  let created = 0
  const createdIds: string[] = []
  const deleted: string[] = []
  const targeted: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const gates: (() => void)[] = []
  // Latching, not one-shot: a pass whose verdict was rejected fires a SECOND
  // command (the verdict retry), and a release that only drained the gates
  // queued at the time would leave that retry blocked forever.
  let released = false
  const release = () => {
    released = true
    for (const g of gates.splice(0)) g()
  }
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      create: async (req: { body?: { parentID?: string; title?: string } }) => {
        const id = `${sessionID}-pass-${++created}`
        createdIds.push(id)
        assert.equal(req?.body?.parentID, sessionID, "a pass session must be a child of the driving session")
        return { data: { id, parentID: req?.body?.parentID } }
      },
      delete: async (req: { path: { id: string } }) => {
        deleted.push(req.path.id)
        return { data: true }
      },
      abort: async () => ({ data: true }),
      command: async (req: { path: { id: string }; body?: { arguments?: string } }) => {
        const passSessionID = req.path.id
        targeted.push(passSessionID)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        // The focus this pass was told to cover, read back out of the prompt the
        // driver appended (`passFocusBlock`) — the same string the pass agent sees.
        const focus = /REVIEW AXIS \d+\/\d+: ([a-z]+)\./.exec(req?.body?.arguments ?? "")?.[1] ?? ""
        if (opts.hold && !released) await new Promise<void>((r) => gates.push(r))
        onCall(passSessionID, focus, deps)
        inFlight--
        return { data: { parts: [{ type: "text", text: `review ${focus}` }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = {
    client,
    $: makeShellFS({}, []),
    directory: "/repo",
    log: (level, msg) => {
      if (level === "warn") opts.warns?.push(msg)
    },
  }
  const run = runStagePasses(
    deps,
    sessionID,
    config,
    manifestFor("engineering"),
    { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
    "review",
    "goal args",
    0,
  )
  return {
    run: async () => {
      try {
        return await run
      } finally {
        clearWorkflow(sessionID)
      }
    },
    release,
    createdIds: () => createdIds,
    deleted: () => deleted,
    targeted: () => targeted,
    maxInFlight: () => maxInFlight,
  }
}

const runAxisReview = async (
  sessionID: string,
  onCall: (call: number, deps: Deps) => void,
  warns: string[] = [],
  config: Config = axisConfig,
  shell: string[] = [],
) => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  let calls = 0
  const fired: string[] = []
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      command: async (req: { body?: { arguments?: string } }) => {
        calls++
        fired.push(req?.body?.arguments ?? "")
        onCall(calls, deps)
        return { data: { parts: [{ type: "text", text: `review pass ${calls}` }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = {
    client,
    $: makeShellFS({}, shell),
    directory: "/repo",
    log: (level, msg) => {
      if (level === "warn") warns.push(msg)
    },
  }
  try {
    const result = await runStagePasses(
      deps,
      sessionID,
      config,
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
    return { result, calls: () => calls, fired }
  } finally {
    clearWorkflow(sessionID)
  }
}

/** Record the single-axis verdict the nth fan-out pass is supposed to record. */
const recordAxis = (sessionID: string, call: number, over: Partial<{ verdict: "PASS" | "FAIL" | "ERROR" }> = {}, findings?: unknown) =>
  recordVerdict(
    sessionID,
    "review",
    worked(sessionID, {
      verdict: over.verdict ?? "PASS",
      axes: [
        {
          axis: FIVE[call - 1]!,
          verdict: over.verdict ?? "PASS",
          ...(findings ? { findings: findings as never } : {}),
        },
      ],
    }),
  )

// --- concurrent fan-out: stageConcurrency ---

test("fan-out runs its passes in parallel with no stageConcurrency set — turning it on IS the request", async () => {
  // Fan-out shipped serial-by-default and needed a second knob to stop being
  // slow, which made a five-axis review cost five reviews of latency for no
  // semantic gain. Configuring ONLY stageFanout must now overlap the passes.
  const h = await runConcurrentAxisReview("sess-conc-implicit", null, (passSessionID, focus) => {
    recordVerdict(passSessionID, "review", worked(passSessionID, { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" }] }))
  }, { hold: true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.maxInFlight(), 5, "all five axis passes in flight at once, with no stageConcurrency configured")
  h.release()
  const { verdict, record } = await h.run()
  assert.equal(verdict, "PASS")
  assert.equal(h.createdIds().length, 5, "one session per pass — the identity concurrency requires")
  assert.deepEqual(record?.axes?.map((a) => a.axis).sort(), [...FIVE].sort(), "all five axes merged")
})

test("stageConcurrency 1 clamps a fan-out back to sequential — no pass sessions are opened", async () => {
  // The knob is a clamp as well as an opt-in: `1` is how a rate-limited setup
  // takes a fanned-out stage back to one pass at a time, so it must not read as
  // "unset" and silently re-parallelize. The fake client below has NO create
  // method, so a driver that opened a pass session would warn — assert it doesn't.
  const warns: string[] = []
  const serial: Config = {
    ...testConfig,
    workflows: { engineering: { stageFanout: { review: "axis" }, stageConcurrency: { review: 1 } } },
  }
  const { calls } = await runAxisReview("sess-conc-default", (call) => {
    // Each pass records its OWN axis — passes fire in manifest order.
    recordVerdict("sess-conc-default", "review", worked("sess-conc-default", { verdict: "PASS", axes: [{ axis: FIVE[call - 1]!, verdict: "PASS" }] }))
  }, warns, serial)
  assert.equal(calls(), 5, "still one pass per axis, no verdict retries")
  assert.ok(!warns.some((w) => /could not open a session/.test(w)), `no pass sessions: ${warns.join(" | ")}`)
})

test("stageConcurrency runs the axis passes at the same time, each in its own session", async () => {
  const h = await runConcurrentAxisReview("sess-conc-par", 5, (passSessionID, focus) => {
    recordVerdict(passSessionID, "review", worked(passSessionID, { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" }] }))
  }, { hold: true })
  // Every pass is held open before any is released — if the driver were still
  // sequential this would deadlock rather than reach 5 in flight.
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.maxInFlight(), 5, "all five passes in flight at once")
  h.release()
  const { verdict, record } = await h.run()
  assert.equal(verdict, "PASS")
  assert.equal(h.createdIds().length, 5, "one session per pass")
  assert.deepEqual([...h.targeted()].sort(), [...h.createdIds()].sort(), "each pass fired on its OWN session")
  assert.deepEqual([...h.deleted()].sort(), [...h.createdIds()].sort(), "and every pass session is torn down")
  assert.deepEqual(record?.axes?.map((a) => a.axis).sort(), [...FIVE].sort(), "all five axes merged")
})

test("a concurrent pass's verdict is admitted against ITS OWN axis requirement", async () => {
  // The reason passes needed their own sessions. `axisRequirement` is keyed by
  // session; sharing one slot meant whichever pass armed last decided which axis
  // every verdict was judged against, so four of five would be rejected for not
  // covering an axis they were told not to review.
  const h = await runConcurrentAxisReview("sess-conc-axis", 5, (passSessionID, focus) => {
    const r = recordVerdict(passSessionID, "review", worked(passSessionID, { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" }] }))
    assert.ok(r.accepted, `pass "${focus}" must be accepted against its own axis: ${r.message}`)
  }, { hold: true })
  await new Promise((r) => setTimeout(r, 20))
  h.release()
  const { verdict, record } = await h.run()
  assert.equal(verdict, "PASS")
  assert.equal(record?.axes?.length, 5)
})

test("one concurrent pass's evidence cannot corroborate another's PASS", async () => {
  // `observedEvidence` is keyed by session too. On a shared slot, a pass that ran
  // nothing would be corroborated by a sibling's commands — the exact fabrication
  // requireEvidence exists to catch.
  const h = await runConcurrentAxisReview("sess-conc-ev", 5, (passSessionID, focus) => {
    // Only the FIRST axis does observable work; the others cite it without doing it.
    const rec: VerdictRecord =
      focus === FIVE[0]
        ? worked(passSessionID, { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" as const }] })
        : { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" }], evidence: [{ kind: "command", ref: "npm test", result: "42 passed" }] }
    const r = recordVerdict(passSessionID, "review", rec)
    if (focus !== FIVE[0]) assert.ok(!r.accepted, `pass "${focus}" observed nothing and must not ride on a sibling's work`)
  }, { hold: true })
  await new Promise((r) => setTimeout(r, 20))
  h.release()
  await h.run()
})

test("concurrent passes keep records index-aligned with passes, whatever order they finish in", async () => {
  // `combineRecords` and the missing-pass detection both read records[i] against
  // passes[i]; append-order collection would scramble them under concurrency.
  const order: string[] = []
  const h = await runConcurrentAxisReview("sess-conc-order", 5, (passSessionID, focus) => {
    order.push(focus)
    recordVerdict(passSessionID, "review", worked(passSessionID, { verdict: "PASS", axes: [{ axis: focus, verdict: "PASS" }] }))
  }, { hold: true })
  await new Promise((r) => setTimeout(r, 20))
  h.release()
  const { output, record } = await h.run()
  assert.equal(record?.axes?.length, 5)
  // The stage output is assembled in PASS order (manifest axis order), not in
  // completion order.
  const seen = FIVE.map((axis) => output.indexOf(`### Review axis: ${axis}`))
  assert.ok(seen.every((i) => i >= 0), `every axis section present: ${output}`)
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, `sections in pass order, not completion order (${order.join(",")})`)
})

test("a pass that cannot open its own session takes turns on the shared one, never overlaps", async () => {
  // `session.create` failing must degrade to sequential, not to two passes
  // sharing one session concurrently — on a shared session `axisRequirement`,
  // `observedEvidence` and `recordedVerdicts` are one slot each, so overlapping
  // is the exact cross-admission the per-pass session exists to prevent.
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const sessionID = "sess-conc-fallback"
  setWorkflow(sessionID, { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {} })
  const warns: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  let call = 0
  const client = {
    tui: { showToast: async () => ({ data: undefined }) },
    session: {
      create: async () => {
        throw new Error("no sessions today")
      },
      delete: async () => ({ data: true }),
      abort: async () => ({ data: true }),
      command: async (req: { path: { id: string } }) => {
        assert.equal(req.path.id, sessionID, "the fallback runs on the driving session")
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS", axes: [{ axis: FIVE[call++]!, verdict: "PASS" }] }))
        inFlight--
        return { data: { parts: [{ type: "text", text: "review" }] } }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, []), directory: "/repo", log: (level, msg) => void (level === "warn" && warns.push(msg)) }
  try {
    const { verdict } = await runStagePasses(
      deps,
      sessionID,
      { ...testConfig, workflows: { engineering: { stageFanout: { review: "axis" }, stageConcurrency: { review: 5 } } } },
      manifestFor("engineering"),
      { kind: "engineering", goal: "g", stage: "review", iteration: 0, artifacts: {}, task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] } },
      "review",
      "goal args",
      0,
    )
    assert.equal(maxInFlight, 1, "shared-session passes must never overlap")
    assert.equal(verdict, "PASS")
    assert.ok(warns.some((w) => /could not open a session/.test(w)), `the degrade is announced: ${warns.join(" | ")}`)
  } finally {
    clearWorkflow(sessionID)
  }
})

test("fan-out: one pass fires per required axis, in manifest order, each told to review only its own", async () => {
  const sessionID = "sess-axis-order"
  const { result, calls, fired } = await runAxisReview(sessionID, (call) => {
    recordAxis(sessionID, call)
  })
  assert.equal(calls(), FIVE.length, "one pass per axis, no retries")
  FIVE.forEach((axis, i) => {
    assert.match(fired[i]!, new RegExp(`REVIEW AXIS ${i + 1}/5: ${axis}\\.`), `pass ${i + 1} is focused on ${axis}`)
    assert.match(fired[i]!, /exactly that one entry/)
    assert.ok(fired[i]!.startsWith("goal args"), "the focus block is appended to the composed prompt, not replacing it")
  })
  assert.equal(result.verdict, "PASS")
  assert.deepEqual(
    (result.record?.axes ?? []).map((a) => a.axis),
    FIVE,
    "the union of the passes covers every required axis",
  )
})

test("fan-out: a pass carrying only its own axis is accepted — the rejection fan-out exists to remove", async () => {
  const sessionID = "sess-axis-accepted"
  const rejections: string[] = []
  await runAxisReview(sessionID, (call) => {
    const r = recordAxis(sessionID, call)
    if (!r.accepted) rejections.push(r.message)
  })
  assert.deepEqual(rejections, [], "no focused pass may be rejected for the axes it was told not to review")
})

test("fan-out: a pass reporting someone else's axis is rejected and names its own", async () => {
  const sessionID = "sess-axis-wrong"
  const rejections: string[] = []
  await runAxisReview(sessionID, (call) => {
    // Every pass reports `correctness`, whoever it is.
    const r = recordVerdict(
      sessionID,
      "review",
      worked(sessionID, { verdict: "PASS", axes: [{ axis: "correctness", verdict: "PASS" }] }),
    )
    if (!r.accepted) rejections.push(r.message)
    else if (call > 1) throw new Error("an off-axis pass must not be admitted")
  })
  assert.ok(rejections.length, "passes 2-5 were rejected")
  assert.match(rejections[0]!, /Missing: readability/)
  assert.doesNotMatch(rejections[0]!, /all 1 axes/)
})

test("fan-out: one axis FAILing with a blocking finding fails the whole stage, prefixed with the axis", async () => {
  const sessionID = "sess-axis-fail"
  const { result } = await runAxisReview(sessionID, (call) => {
    if (FIVE[call - 1] === "security") {
      recordVerdict(sessionID, "review", {
        verdict: "FAIL",
        reason: "missing authz check",
        axes: [
          {
            axis: "security",
            verdict: "FAIL",
            findings: [{ severity: "critical", detail: "no authz on the delete route", location: "api.ts:42" }],
          },
        ],
      })
    } else recordAxis(sessionID, call)
  })
  assert.equal(result.verdict, "FAIL")
  assert.match(result.record?.reason ?? "", /\[security\] missing authz check/)
  assert.equal(result.record?.axes?.length, FIVE.length, "the passing axes' evidence survives alongside the failure")
})

test("fan-out: an axis pass that never records a verdict → ERROR naming it, never FAIL", async () => {
  const sessionID = "sess-axis-missing"
  const warns: string[] = []
  const { result, calls } = await runAxisReview(
    sessionID,
    (call) => {
      // The security pass (4th) and its one retry record nothing.
      if (call <= 3) recordAxis(sessionID, call)
      else if (call > 5) recordAxis(sessionID, call - 1)
    },
    warns,
  )
  assert.equal(result.verdict, "ERROR", "a broken verdict channel must stop, not burn a rebuild iteration")
  assert.match(result.record?.reason ?? "", /security/)
  assert.match(result.record?.reason ?? "", /axis: security/, "the tag says axis, not lens")
  // A missing pass does not abort the fan-out — the remaining axes still run, so
  // the run log holds every finding the review did manage to produce.
  assert.equal(calls(), 6, "3 clean passes + the security pass and its one retry + the performance pass")
  assert.ok(warns.some((w) => /re-running the pass once/.test(w)))
})

test("fan-out: a genuine FAIL plus a missing axis still stops with ERROR — no rebuild on partial information", async () => {
  const sessionID = "sess-axis-fail-and-missing"
  const { result } = await runAxisReview(sessionID, (call) => {
    if (call === 1) {
      recordVerdict(sessionID, "review", {
        verdict: "FAIL",
        reason: "off-by-one",
        axes: [
          { axis: "correctness", verdict: "FAIL", findings: [{ severity: "critical", detail: "off-by-one", location: "a.ts:1" }] },
        ],
      })
    }
    // pass 2 (readability) and its retry record nothing
  })
  assert.equal(result.verdict, "ERROR")
})

test("fan-out: an ESC interrupt mid-fan-out fires no further axis and no retry", async () => {
  const sessionID = "sess-axis-esc"
  const warns: string[] = []
  const { clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  // Pinned to one pass at a time, which is where "no FURTHER axis" is even a
  // question: the pool checks the halt before TAKING work, so a fan-out running
  // at its parallel default has already taken every pass by the time ESC lands
  // (those in flight are aborted by `onInterrupt`, not by this check).
  const serial: Config = {
    ...testConfig,
    workflows: { engineering: { stageFanout: { review: "axis" }, stageConcurrency: { review: 1 } } },
  }
  const { result, calls } = await runAxisReview(
    sessionID,
    () => {
      clearWorkflow(sessionID)
    },
    warns,
    serial,
  )
  assert.equal(result.verdict, null)
  assert.equal(result.record, null)
  assert.equal(calls(), 1)
  assert.ok(!warns.some((w) => /stopping with ERROR/.test(w)), `unexpected warn: ${warns.join(" | ")}`)
})

test("fan-out: each pass is logged under its own axis in the `lens` slot the run-log parser already reads", async () => {
  const sessionID = "sess-axis-runlog"
  const shell: string[] = []
  const { result } = await runAxisReview(sessionID, (call) => recordAxis(sessionID, call), [], axisConfig, shell)
  assert.equal(result.verdict, "PASS")
  for (const axis of FIVE) {
    assert.ok(
      shell.some((c) => c.includes(`review (lens: ${axis}) · iteration 1`)),
      `the run log records a ${axis} pass — reusing \`lens:\` keeps runlog.ts and the hub's per-pass panels working`,
    )
  }
})

test("fan-out: configured reviewLenses win, and each pass gets the lens contract", async () => {
  const sessionID = "sess-axis-vs-lenses"
  const both: Config = { ...axisConfig, reviewLenses: ["a hostile attacker", "the next maintainer"] }
  const { calls, fired } = await runAxisReview(
    sessionID,
    () => recordVerdict(sessionID, "review", worked(sessionID, { verdict: "PASS" })),
    [],
    both,
  )
  assert.equal(calls(), 2, "the two lenses ran, not the five axes")
  assert.equal(
    fired[0],
    "goal args\n\nREVIEW LENS 1/2: a hostile attacker. Focus exclusively on a hostile attacker. The other lenses " +
      "run as separate passes — don't repeat them. Record this pass's verdict via workflow_verdict as usual, " +
      "carrying per-axis results only for the axes your lens actually bears on.",
    "each lens pass is told which lens it owns, on the line its contract points at",
  )
  assert.ok(!fired.some((f) => /REVIEW AXIS/.test(f)))
})

// --- configSources: the `kinds` toast names which config files are in effect ---

const withUserConfig = <T>(value: string | undefined, fn: () => T): T => {
  const orig = process.env.AGENTIC_WORKFLOW_USER_CONFIG
  if (value === undefined) delete process.env.AGENTIC_WORKFLOW_USER_CONFIG
  else process.env.AGENTIC_WORKFLOW_USER_CONFIG = value
  try {
    return fn()
  } finally {
    if (orig === undefined) delete process.env.AGENTIC_WORKFLOW_USER_CONFIG
    else process.env.AGENTIC_WORKFLOW_USER_CONFIG = orig
  }
}

test("configSources names both layers so a kind that reads as disabled is traceable to a file", () => {
  const line = withUserConfig("/nowhere/user-wf.json", () => configSources())
  assert.match(line, /\.agentic-workflow\.json \(repo, wins\)/)
  assert.match(line, /\/nowhere\/user-wf\.json/)
  assert.match(line, /\(absent\)/, "a user path that does not exist must say so, not look loaded")
})

test("configSources reports a disabled user layer rather than naming a phantom path", () => {
  assert.match(
    withUserConfig("", () => configSources()),
    /user-scope layer is disabled/,
  )
})

// --- driveChain publishes the transition immediately, not one stage later ---

// The stage a verdict is judged against is `getWorkflow(sessionID).stage`, and
// `driveChain` used to publish it only at the TOP of the next iteration — after
// `ensureIsolation` and `runStageChecks`, which shell out and can take minutes.
// For that whole window the store still named the stage the loop had already
// left, so a straggler workflow_verdict from the finished stage's subagent (still
// settling in the abort-grace window) was ACCEPTED into the stage that just
// ended rather than rejected as drift.
//
// A source lint rather than a behavioural test because `driveChain` is not
// exported and the window is defined by statement ORDER, which is exactly what a
// refactor loses. Same technique the Claude server's tests use for its ordering
// invariants.
test("driveChain publishes the advanced state before awaiting anything else", async () => {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const src = fs.readFileSync(path.join(import.meta.dirname, "driver.ts"), "utf8")
  const advanceAt = src.indexOf("step = advance(loaded, step.state")
  assert.ok(advanceAt > -1, "driveChain's transition moved — re-point this lint")
  // The loop body ends at the next line that closes it; everything the transition
  // is followed by lives in this slice.
  const afterAdvance = src.slice(advanceAt, src.indexOf("\n  }\n", advanceAt))
  assert.match(afterAdvance, /setWorkflow\(sessionID, step\.state\)/, "the transition must be published before the next await")
  assert.doesNotMatch(afterAdvance, /await /, "nothing may be awaited between the transition and publishing it")
})
