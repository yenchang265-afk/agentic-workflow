import assert from "node:assert/strict"
import { test } from "node:test"
import { PLAN_HEADING } from "@agentic-workflow/core/task/store"
import { serializeTask } from "@agentic-workflow/core/task/schema"
import { firstStep } from "@agentic-workflow/core/workflow/engine"
import { clearWorkflow, setWorkflow, type WorkflowState } from "@agentic-workflow/core/workflow/state"
import type { Config } from "../config.ts"
import {
  abortedSessionID,
  claimSkipReason,
  configSources,
  deriveActivity,
  drive,
  handleApprove,
  handleCommand,
  handleRemove,
  handleReplan,
  manifestFor,
  onInterrupt,
  parseWatchArgs,
  recordVerdict,
  findDrivingWorkflow,
  resolveDrivingSession,
  runStageWithLenses,
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
 * hybrid: its placement half is a plugin move, the reshape after it is not.
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

  await handleCommand(deps, "sess", "retask my-task tighten acceptance", testConfig)

  assert.equal(toasts.length, 0, "no toast — the agent's turn reports the reshape")
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "nothing to move")
})

test("retask on an approved queued task sends it back to draft and says so", async () => {
  const files = { "docs/tasks/queued/my-task.md": serializeTask({ title: "Do the thing", body: "approved, no plan yet" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "retask my-task tighten acceptance", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /draft/)
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("draft")), "the task moves back to draft/")
})

test("retask on a parked plan is refused and points at replan", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Planned", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "retask my-task", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /replan/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "a planned task is never moved by retask")
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
    } else if (parts[0] === "rm") {
      // rm [-f] <path…> — drop any listed paths from the fake fs (missing is fine).
      for (const p of parts.slice(1)) if (p !== "-f" && p in fs) delete fs[p]
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
  watchIntervalMinutes: 5,
  worktreesDir: false,
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

  await handleCommand(deps, "sess", "replan my-task misses the cache layer", testConfig)

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

  await handleCommand(deps, "sess", "replan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
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

test("/approve with no id ships the single in-review task to completed/", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed diff" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("completed")))
  // The fake shell's default (unmatched → exitCode 0, empty stdout) makes the
  // branch "exist" and the push "succeed", but every `gh` call reads as empty
  // output — i.e. attempted-but-failed, not "no branch".
  assert.ok(log.some((cmd) => cmd.includes("PR not opened")))
  assert.ok(!(toasts[0]?.message ?? "").includes("PR:"))
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

test("id-less approve refuses to guess between two drafts", async () => {
  const files = {
    "docs/tasks/draft/task-a.md": serializeTask({ title: "A", body: "x" }),
    "docs/tasks/draft/task-b.md": serializeTask({ title: "B", body: "y" }),
  }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Multiple tasks awaiting/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "no move when ambiguous")
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

  await handleReplan(deps, "sess", "the migration order is unsafe", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("the migration order is unsafe")))
})

test("/reject <id> [reason] captures the id and the trailing reason", async () => {
  const files = { "docs/tasks/plan-review/my-task.md": serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleReplan(deps, "sess", "my-task misses the cache layer", testConfig)

  assert.equal(toasts[0]?.variant, "success")
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

test("/remove <id> hard-deletes the task file — rm, no mv", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "x" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleRemove(deps, "sess", "my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.match(toasts[0]?.message ?? "", /removed/)
  assert.ok(log.some((cmd) => cmd.startsWith("rm ")), "the file is deleted")
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "and never moved")
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

  await handleCommand(deps, "sess", "replan the migration order is unsafe", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("the migration order is unsafe")))
})

test("id-less approve ships the single in-review task (ship verb is gone)", async () => {
  const files = { "docs/tasks/in-review/my-task.md": serializeTask({ title: "Ship it", body: "reviewed" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "approve", testConfig)

  assert.equal(toasts[0]?.variant, "success")
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
  assert.match(toasts[0]?.message ?? "", /dep-sitter \(disabled\)/)
  // The released sitters read as "always on", not "enabled" — otherwise the
  // reader goes looking for a toggle that does not exist.
  assert.match(toasts[0]?.message ?? "", /pr-sitter \(always on\)/)
  assert.match(toasts[0]?.message ?? "", /review-sitter \(always on\)/)
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

test("authoring/gate verbs return undefined so their command markdown reaches the model", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "x" })
  const files = { "docs/tasks/draft/my-task.md": draft }
  const { client } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  // new/approve intentionally pass through: overriding them would strip the
  // interview turn / the approve glob-verify flow the markdown drives.
  assert.equal(await handleCommand(deps, "sess", "new add rate limiting", testConfig), undefined)
  assert.equal(await handleCommand(deps, "sess", "approve my-task", testConfig), undefined)
})

test("an unknown verb gets the engineering usage toast", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "no-such-verb", testConfig)

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
    assert.match(recordVerdict("drv-sess", "verify", { verdict: "PASS" }).message, /Recorded verify verdict: PASS/)
  } finally {
    clearWorkflow("drv-sess")
  }
})

// --- stage drift: an out-of-stage verdict is rejected AND audited on the task ---

test("recordVerdict audits an out-of-stage verdict on the task file, once per stage attempt", async () => {
  const { setWorkflow, clearWorkflow } = await import("@agentic-workflow/core/workflow/state")
  const shellLog: string[] = []
  const task = { id: "drift-task", path: "/repo/docs/tasks/in-progress/drift-task.md", acceptance: [] }
  const deps: Deps = { client: makeClient().client, $: makeShellFS({}, shellLog), directory: "/repo", log: () => {} }
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
    assert.match(recordVerdict("drv-ok", "verify", { verdict: "PASS" }, deps).message, /Recorded verify verdict: PASS/)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(shellLog.filter((cmd) => cmd.includes("Stage drift")).length, 0, "no drift note on the happy path")
  } finally {
    clearWorkflow("drv-ok")
  }
})

// --- runStageWithLenses: a missing lens verdict is a broken channel, not a FAIL ---
// Regression guard for the spurious-second-iteration bug: with reviewLenses
// configured, a lens whose workflow_verdict call never lands used to combine as
// null→FAIL (worstOf) and fire a rebuild of already-passing work; it must take
// the same ERROR→recoverable-stop path as the single-pass case.

const lensConfig: Config = { ...testConfig, reviewLenses: ["correctness", "security"] }

/** Run the review stage with two lenses; `onCall(n, deps)` runs before the nth stage command returns. */
const runLensReview = async (sessionID: string, onCall: (call: number, deps: Deps) => void, warns: string[] = []) => {
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
    const result = await runStageWithLenses(
      deps,
      sessionID,
      lensConfig,
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
    return await runStageWithLenses(
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
    recordVerdict(sessionID, "review", { verdict: "PASS", axes: cleanAxes })
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
    recordVerdict(sessionID, "review", { verdict: "PASS", axes: cleanAxes })
  })
  assert.equal(result.verdict, "FAIL")
})

test("review: a complete five-axis verdict is accepted", async () => {
  const sessionID = "sess-axes-complete"
  const result = await runSinglePassReview(sessionID, () => {
    recordVerdict(sessionID, "review", { verdict: "PASS", axes: cleanAxes })
  })
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

test("lens mode suppresses axis enforcement — a lens pass records its own focus only", async () => {
  // Each lens is told to focus exclusively on its own lens; demanding all five
  // axes from it would reject every pass and wedge the loop.
  const sessionID = "sess-axes-lens"
  const { result } = await runLensReview(sessionID, () => {
    const r = recordVerdict(sessionID, "review", { verdict: "PASS" })
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
        ? { verdict: "PASS", axes: [{ axis: "security", verdict: "PASS", findings: [{ severity: "suggestion", detail: "lens A context" }] }] }
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
    recordVerdict(sessionID, "review", { verdict: "PASS" })
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
    if (call === 1) recordVerdict(sessionID, "review", { verdict: "PASS" })
    // calls 2 and 3 (the security lens and its retry): no verdict recorded
  })
  assert.equal(result.verdict, "ERROR", "a broken lens verdict channel must stop, not rebuild")
  assert.match(result.record?.reason ?? "", /security/)
  assert.equal(calls(), 3, "1 correctness pass + security pass and its one retry")
})

test("lenses: a genuine lens FAIL combines worst-wins with the lens-prefixed reason", async () => {
  const sessionID = "sess-lens-fail"
  const { result } = await runLensReview(sessionID, (call) => {
    recordVerdict(
      sessionID,
      "review",
      call === 1 ? { verdict: "PASS" } : { verdict: "FAIL", reason: "auth bypass in handler" },
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
