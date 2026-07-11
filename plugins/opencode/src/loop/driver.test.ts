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
  handleApprove,
  handleCommand,
  handleReplan,
  manifestFor,
  onInterrupt,
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
  assert.match(r.message, /\/agentic-loop:engineering recover <id>/)
})

test("a backlog with neither started nor held tasks falls back to the no-plan hint", () => {
  const r = claimSkipReason(1, 0, 0, [], [])
  assert.equal(r.actionable, true)
  assert.match(r.message, /no persisted plan/)
})

/**
 * Verb classification of the `/agentic-loop:engineering` command: `new` and `retask`
 * are agent work (interview + draft write) and must pass through silently —
 * no toast, no move — so the command template's model turn runs.
 */

test("new and retask pass through without a toast or a move", async () => {
  const { client, toasts } = makeClient()
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "new add rate limiting", testConfig)
  await handleCommand(deps, "sess", "retask my-task tighten acceptance", testConfig)

  assert.equal(toasts.length, 0)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "authoring verbs never move task files")
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
 * The deterministic gate verbs of the `/agentic-loop:engineering` command.
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

test("id-less approve ignores drafts — a lone draft is not queued (drafts need an explicit id)", async () => {
  const files = { "docs/tasks/draft/my-task.md": serializeTask({ title: "Do the thing", body: "no plan yet" }) }
  const { client, toasts } = makeClientFS(files)
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS(files, log), directory: "/repo", log: () => {} }

  await handleApprove(deps, "sess", "", testConfig)

  assert.equal(toasts[0]?.variant, "info")
  assert.match(toasts[0]?.message ?? "", /Nothing awaiting approval/)
  assert.match(toasts[0]?.message ?? "", /approve <id>/)
  assert.ok(!log.some((cmd) => cmd.startsWith("mv ")), "a draft is not approved without an explicit id")
})

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
  assert.match(toasts[0]?.message ?? "", /\/agentic-loop:engineering replan/)
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
    assert.match(t.message, /agentic-loop:pr-sitter claim · watch/)
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
  assert.match(toasts[0]?.message ?? "", /pr-sitter \(disabled\)/)
})

test("an unknown verb gets the engineering usage toast", async () => {
  const { client, toasts } = makeClientFS({})
  const log: string[] = []
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  await handleCommand(deps, "sess", "no-such-verb", testConfig)

  assert.equal(toasts[0]?.variant, "warning")
  assert.match(toasts[0]?.message ?? "", /Unknown \/agentic-loop:engineering mode/)
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
            parts: [{ type: "text", text: "triaged: nothing to do" }],
          },
        }
      },
    },
  } as unknown as Deps["client"]
  const deps: Deps = { client, $: makeShellFS({}, log), directory: "/repo", log: () => {} }

  const state: LoopState = {
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
