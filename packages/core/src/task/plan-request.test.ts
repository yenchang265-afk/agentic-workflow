import assert from "node:assert/strict"
import { test } from "node:test"
import type { Task } from "./schema.js"
import {
  consumePlanRequest,
  listPlanRequestIds,
  listPlanRequests,
  planRequestPath,
  requestPlan,
  requestedFirst,
  requestsDir,
  revokePlanRequest,
  sweepStalePlanRequests,
} from "./plan-request.js"

/**
 * An in-memory filesystem behind the `Shell` port — enough of `mkdir -p`,
 * `printf > `, `mv`, `test -f`, `rm -f`, `ls -1` and `cat` for the real
 * `writeFileAtomic` path to run unmodified. A handler that just returned exit
 * codes would prove the calls were made but not that the marker is readable
 * afterwards, which is the only thing worth asserting here.
 */
const makeFs = (seed: Record<string, string> = {}) => {
  const files = new Map<string, string>(Object.entries(seed))
  const log: string[] = []
  const run = (cmd: string): { exitCode: number; stdout: string } => {
    const ok = { exitCode: 0, stdout: "" }
    if (cmd.startsWith("mkdir -p ")) return ok
    const redirect = cmd.match(/^printf '%s' (.*) (>>?) (\S+)$/)
    if (redirect) {
      const [, content = "", mode, dest = ""] = redirect
      files.set(dest, mode === ">>" ? (files.get(dest) ?? "") + content : content)
      return ok
    }
    const moved = cmd.match(/^mv (?:-n )?(\S+) (\S+)$/)
    if (moved) {
      const [, src = "", dest = ""] = moved
      if (!files.has(src)) return { exitCode: 1, stdout: "" }
      files.set(dest, files.get(src) as string)
      files.delete(src)
      return ok
    }
    if (cmd.startsWith("test -f ")) return files.has(cmd.slice(8)) ? ok : { exitCode: 1, stdout: "" }
    if (cmd.startsWith("test -e ")) return files.has(cmd.slice(8)) ? ok : { exitCode: 1, stdout: "" }
    if (cmd.startsWith("rm -f ")) {
      files.delete(cmd.slice(6))
      return ok
    }
    if (cmd.startsWith("cat ")) {
      const content = files.get(cmd.slice(4))
      return content === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: content }
    }
    if (cmd.startsWith("ls -1 ")) {
      const dir = `${cmd.slice(6)}/`
      const names = [...files.keys()].filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length))
      // A real `ls` of a missing directory fails; the caller's `[]` depends on it.
      return names.length === 0 ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: `${names.join("\n")}\n` }
    }
    return ok
  }
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = run(cmd)
        return Promise.resolve({
          exitCode: r.exitCode,
          stdout: { toString: () => r.stdout },
          stderr: { toString: () => "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
  return { $, files, log }
}

const DIR = "/r"
const TASKS = "docs/tasks"
const at = (id: string) => planRequestPath(DIR, TASKS, id)

const task = (id: string, priority: number): Task => ({
  id,
  title: id,
  priority,
  acceptance: [],
  labels: [],
  body: "",
  path: `/r/${TASKS}/queued/${id}.md`,
})

test("requestsDir sits beside the .claims/ markers of the same folder", () => {
  assert.equal(requestsDir(DIR, TASKS), "/r/docs/tasks/queued/.requests")
  assert.equal(at("t1"), "/r/docs/tasks/queued/.requests/t1")
})

test("requestPlan writes a readable stamp, and lands it with an atomic rename", async () => {
  const { $, files, log } = makeFs()
  assert.equal(await requestPlan($, DIR, TASKS, "t1", { now: new Date("2026-07-30T10:00:00.000Z") }), true)
  assert.deepEqual(JSON.parse(files.get(at("t1")) as string), {
    requestedAt: "2026-07-30T10:00:00.000Z",
    source: "hub",
  })
  // Via a temp file, not straight onto the marker: a reader mid-write sees the
  // old marker or the new one, never a truncated stamp.
  assert.ok(
    log.some((c) => c.startsWith("mv ") && c.endsWith(at("t1"))),
    `no atomic rename in ${log.join(" | ")}`,
  )
})

test("requestPlan records who asked when the caller knows", async () => {
  const { $, files } = makeFs()
  await requestPlan($, DIR, TASKS, "t1", { by: "Ada <ada@example.com>" })
  assert.equal((JSON.parse(files.get(at("t1")) as string) as { by?: string }).by, "Ada <ada@example.com>")
})

test("a second request restamps rather than adding a second marker — requesting twice is one request", async () => {
  const { $ } = makeFs()
  await requestPlan($, DIR, TASKS, "t1", { now: new Date("2026-07-30T10:00:00.000Z") })
  await requestPlan($, DIR, TASKS, "t1", { now: new Date("2026-07-30T11:00:00.000Z") })
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), ["t1"])
  assert.equal((await listPlanRequests($, DIR, TASKS))[0]?.requestedAt, "2026-07-30T11:00:00.000Z")
})

test("revoke removes the marker; revoking again is a no-op returning false, never a throw", async () => {
  const { $ } = makeFs()
  await requestPlan($, DIR, TASKS, "t1")
  assert.equal(await revokePlanRequest($, DIR, TASKS, "t1"), true)
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), [])
  assert.equal(await revokePlanRequest($, DIR, TASKS, "t1"), false, "idempotent: a double-click must not error")
})

test("consumePlanRequest is the same removal, named for the claim that honoured it", async () => {
  const { $ } = makeFs()
  await requestPlan($, DIR, TASKS, "t1")
  assert.equal(await consumePlanRequest($, DIR, TASKS, "t1"), true)
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), [])
})

test("an absent .requests/ directory lists as empty — the normal case, not an error", async () => {
  const { $ } = makeFs()
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), [])
  assert.deepEqual(await listPlanRequests($, DIR, TASKS), [])
})

test("a garbled stamp yields the id with no time — a request with no time beats one with a wrong time", async () => {
  const { $ } = makeFs({ [at("t1")]: "{not json" })
  assert.deepEqual(await listPlanRequests($, DIR, TASKS), [{ id: "t1" }])
})

test("an unsafe id is refused before it becomes a path", async () => {
  const { $, files, log } = makeFs()
  assert.equal(await requestPlan($, DIR, TASKS, "../../etc/passwd"), false)
  assert.equal(await revokePlanRequest($, DIR, TASKS, "../../etc/passwd"), false)
  assert.equal(files.size, 0)
  assert.equal(log.length, 0, `nothing may reach the shell: ${log.join(" | ")}`)
})

test("junk dropped into .requests/ by hand is ignored rather than joined back into a path", async () => {
  const { $ } = makeFs({ [`${requestsDir(DIR, TASKS)}/..`]: "x", [`${requestsDir(DIR, TASKS)}/t1`]: "{}" })
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), ["t1"])
})

test("sweepStalePlanRequests drops exactly the requests whose task has left the folder", async () => {
  const { $ } = makeFs()
  await requestPlan($, DIR, TASKS, "still-here")
  await requestPlan($, DIR, TASKS, "moved-on")
  assert.deepEqual(await sweepStalePlanRequests($, DIR, TASKS, ["still-here"]), ["moved-on"])
  assert.deepEqual(await listPlanRequestIds($, DIR, TASKS), ["still-here"])
})

test("requestedFirst hoists the requested task and preserves selectOrder within each group", () => {
  const ordered = [task("a", 1), task("b", 2), task("c", 3)]
  assert.deepEqual(
    requestedFirst(ordered, new Set(["c"])).map((t) => t.id),
    ["c", "a", "b"],
  )
  assert.deepEqual(
    requestedFirst(ordered, new Set(["b", "c"])).map((t) => t.id),
    ["b", "c", "a"],
    "two requests resolve among themselves by the order they arrived in, i.e. by priority",
  )
})

test("requestedFirst with no requests is the identity, and never mutates its input", () => {
  const ordered = [task("a", 1), task("b", 2)]
  assert.deepEqual(
    requestedFirst(ordered, new Set()).map((t) => t.id),
    ["a", "b"],
  )
  requestedFirst(ordered, new Set(["b"]))
  assert.deepEqual(ordered.map((t) => t.id), ["a", "b"], "the caller's candidate list is left alone")
})
