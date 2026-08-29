import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { Shell, ShellPromise } from "@agentic-workflow/core/host"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { HubDeps } from "./deps.js"
import { fsClient } from "./fsclient.js"
import { gateCtx } from "./gatectx.js"

/**
 * The bounded gate shell, on the third surface that makes gate moves.
 *
 * Designs 21 (OpenCode) and 42 (the model hosts) shipped the same cap twice;
 * the hub kept running `approveTask`/`approvePlan`/`replanTask`/`shipTask` — the
 * last of which shells to `git push` and `gh pr create` — on a raw shell, inside
 * an HTTP request. One hung git command pends that request forever with the task
 * file possibly already moved: design 21's incident, replayed with a mouse.
 */

const BOARDS = [
  {
    kind: "engineering",
    description: "",
    sourceType: "backlog",
    statuses: ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"],
    gateStatuses: ["plan-review", "in-review"],
    pools: ["queued", "in-progress"],
  },
]

/** A shell that records every cap asked of it and never actually spawns. */
const recordingSh = (caps: number[], withTimeout: boolean): Shell => {
  const make = (): unknown => {
    const p: Record<string, unknown> = {
      quiet: () => p,
      nothrow: () => p,
      cwd: () => p,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve),
    }
    if (withTimeout)
      p.timeout = (ms: number) => {
        caps.push(ms)
        return p
      }
    return p
  }
  return (() => make() as ShellPromise) as Shell
}

const depsWith = (directory: string, sh: Shell): HubDeps =>
  ({
    directory,
    tasksDir: "docs/tasks",
    boards: BOARDS,
    config: DEFAULT_CONFIG,
    workflowsDir: path.join(directory, "workflows-unused"),
    projectsDir: "/nonexistent-projects",
    opencodeDbPath: "/nonexistent.db",
    client: fsClient,
    sh,
    log: () => {},
  }) as unknown as HubDeps

const fixture = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-gatectx-"))

test("every gate move the hub makes runs on a bounded shell", async () => {
  const dir = fixture()
  try {
    const caps: number[] = []
    const ctx = await gateCtx(depsWith(dir, recordingSh(caps, true)))
    await ctx.$`git push origin feature/t`.quiet().nothrow()
    assert.equal(caps.length, 1, "the gate shell must cap the command it was handed")
    assert.ok((caps[0] ?? 0) > 0, `a real deadline, not zero: ${caps[0]}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a shell with no .timeout degrades to the unbounded call rather than failing the move", async () => {
  // `.timeout` is optional on the host interface — a host that cannot reap a
  // child omits it — and the adapter must degrade, not turn that into a 500.
  const dir = fixture()
  try {
    const ctx = await gateCtx(depsWith(dir, recordingSh([], false)))
    const out = await ctx.$`git status`.quiet().nothrow()
    assert.equal(out.exitCode, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
