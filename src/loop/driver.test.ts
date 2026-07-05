import assert from "node:assert/strict"
import { test } from "node:test"
import { PLAN_HEADING } from "../task/store.ts"
import { serializeTask } from "../task/schema.ts"
import type { Config } from "./state.ts"
import { claimSkipReason, handleTaskCommand, parseTaskArgs, parseWatchArgs, type Deps } from "./driver.ts"

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

test("new and free text pass through", () => {
  assert.deepEqual(parseTaskArgs("new add rate limiting"), { mode: "passthrough" })
  assert.deepEqual(parseTaskArgs(""), { mode: "passthrough" })
  assert.deepEqual(parseTaskArgs("approver thing"), { mode: "passthrough" })
})

/**
 * `handleTaskCommand` gates. Fakes `client.file.read`/`client.tui.showToast`;
 * the exploding `$` proves no move is attempted on a refusal.
 */

const explodingShell = ((..._args: unknown[]) => {
  throw new Error("$ should not be called")
}) as unknown as Deps["$"]

const makeClient = (files: Record<string, string>) => {
  const toasts: { message: string; variant: string }[] = []
  const client = {
    file: {
      read: async ({ query }: { query: { path: string } }) => {
        const content = files[query.path]
        return { data: content !== undefined ? { content } : undefined }
      },
    },
    tui: {
      showToast: async ({ body }: { body: { message: string; variant: string } }) => {
        toasts.push(body)
        return { data: undefined }
      },
    },
  } as unknown as Deps["client"]
  return { client, toasts }
}

const testConfig: Config = {
  maxIterations: 1,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 10,
  watchIntervalMinutes: 5,
  reviewLenses: [],
}

/** Mirrors the fake shell in `../task/store.test.ts` / `git.test.ts` — always succeeds, records commands. */
const makeSucceedingShell = (log: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    log.push(cmd.trim().replace(/\s+/g, " "))
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(
          resolve,
        ),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

test("approve moves a draft to queued/ without requiring a plan", async () => {
  const draft = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient({ "docs/tasks/draft/my-task.md": draft })
  const log: string[] = []
  const deps: Deps = { client, $: makeSucceedingShell(log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})

test("approve refuses a task that is not in draft/", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient({ "docs/tasks/queued/my-task.md": queued })
  const deps: Deps = { client, $: explodingShell, directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /it's in queued/)
})

test("approve-plan refuses a queued task that the loop has not planned yet", async () => {
  const queued = serializeTask({ title: "Do the thing", body: "Some context." })
  const { client, toasts } = makeClient({ "docs/tasks/queued/my-task.md": queued })
  const deps: Deps = { client, $: explodingShell, directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /still queued/)
})

test("approve-plan refuses a plan-review task whose plan heading is missing", async () => {
  const planless = serializeTask({ title: "Do the thing", body: "Some context, no plan." })
  const { client, toasts } = makeClient({ "docs/tasks/plan-review/my-task.md": planless })
  const deps: Deps = { client, $: explodingShell, directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts.length, 1)
  assert.match(toasts[0]?.message ?? "", /no Implementation Plan/)
})

test("approve-plan moves a planned plan-review task to in-progress/", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient({ "docs/tasks/plan-review/my-task.md": planned })
  const log: string[] = []
  const deps: Deps = { client, $: makeSucceedingShell(log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "approve-plan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("in-progress")))
})

test("replan sends a plan-review task back to queued/ with the reason noted", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient({ "docs/tasks/plan-review/my-task.md": planned })
  const log: string[] = []
  const deps: Deps = { client, $: makeSucceedingShell(log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "replan my-task misses the cache layer", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
  assert.ok(log.some((cmd) => cmd.includes("misses the cache layer")))
})

test("replan also accepts a cap-tripped in-progress task", async () => {
  const planned = serializeTask({ title: "Do the thing", body: `${PLAN_HEADING}\n\n1. Step.` })
  const { client, toasts } = makeClient({ "docs/tasks/in-progress/my-task.md": planned })
  const log: string[] = []
  const deps: Deps = { client, $: makeSucceedingShell(log), directory: "/repo", log: () => {} }

  await handleTaskCommand(deps, "sess", "replan my-task", testConfig)

  assert.equal(toasts[0]?.variant, "success")
  assert.ok(log.some((cmd) => cmd.includes("mv") && cmd.includes("queued")))
})
