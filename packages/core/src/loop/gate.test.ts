import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { PLAN_HEADING } from "../task/store.js"
import { serializeTask } from "../task/schema.js"
import { approvePlan, approveTask, replanTask, shipTask, type GateCtx } from "./gate.js"

/**
 * The shared gate moves, driven against a tiny in-memory backlog. A fake shell
 * models `cat`/`mv` over a file map (the id-based ops need only those); git
 * commands report "no branch/actor" so ship attempts no PR. The no-id
 * `resolveGateTask` path is covered end-to-end by the OpenCode driver tests.
 */
const makeCtx = (files: Record<string, string>, opts: { driving?: string } = {}) => {
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
    else if (parts[0] === "mv") {
      const [, src, dest] = parts
      if (src! in fs) {
        fs[dest!] = fs[src!]!
        delete fs[src!]
      } else out = { exitCode: 1, stdout: "" }
    } else if (parts[0] === "git") out = { exitCode: 1, stdout: "" } // no actor, no branch → no PR
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

test("shipTask moves an in-review task to completed (no branch → no PR)", async () => {
  const { ctx, fs } = makeCtx({ "in-review/t.md": task("Do it") })
  const r = await shipTask(ctx, "t")
  assert.ok(r.ok && typeof r.data.completed === "string")
  assert.ok(!("pr" in (r.ok ? r.data : {})), "no PR attempted without a feature branch")
  assert.ok("/repo/docs/tasks/completed/t.md" in fs)
})
