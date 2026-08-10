import assert from "node:assert/strict"
import os from "node:os"
import { test } from "node:test"
import type { Shell } from "./host.js"
import { isSameMachine, machineId, pidAlive, pidGone, resetMachineIdCache } from "./liveness.js"

/**
 * Process liveness is the one judgement in the workflow that must fail CLOSED:
 * a false "gone" authorizes a claim takeover, i.e. a second drive on one
 * feature branch. So most of what is pinned here is the REFUSAL to conclude
 * death — EPERM, an unusable probe, a machine we cannot place.
 */

interface FakeOpts {
  /** Pids `kill -0` reports as signalable. */
  readonly signalable?: ReadonlySet<number>
  /** Pids visible under /proc; undefined means /proc itself is unavailable. */
  readonly procPids?: ReadonlySet<number>
  /** Pids `ps` lists; undefined means ps returns nothing usable. */
  readonly psPids?: ReadonlySet<number>
  readonly bootId?: string | null
}

const fakeShell = (opts: FakeOpts = {}) => {
  const cmds: string[] = []
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    const exec = (): { exitCode: number; stdout: string } => {
      cmds.push(norm)
      const kill = /^kill -0 (\d+)$/.exec(norm)
      if (kill) return { exitCode: opts.signalable?.has(Number(kill[1])) ? 0 : 1, stdout: "" }
      const proc = /^test -d \/proc\/(\d+)$/.exec(norm)
      if (proc) return { exitCode: opts.procPids?.has(Number(proc[1])) ? 0 : 1, stdout: "" }
      const ps = /^ps -o pid= -p (\S+)$/.exec(norm)
      if (ps) {
        if (!opts.psPids) return { exitCode: 1, stdout: "" }
        const asked = ps[1]!.split(",").map(Number)
        return { exitCode: 0, stdout: asked.filter((p) => opts.psPids?.has(p)).join("\n") }
      }
      if (norm === "cat /proc/sys/kernel/random/boot_id") {
        return opts.bootId ? { exitCode: 0, stdout: `${opts.bootId}\n` } : { exitCode: 1, stdout: "" }
      }
      return { exitCode: 0, stdout: "" }
    }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        const out = exec()
        return Promise.resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout }, stderr: { toString: () => "" } }).then(resolve)
      },
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as Shell
  return { $, cmds }
}

const SELF = process.pid
const OTHER = 424242

test("pidAlive reports only what kill -0 can confirm", async () => {
  const { $ } = fakeShell({ signalable: new Set([SELF]) })
  assert.equal(await pidAlive($, SELF), true)
  assert.equal(await pidAlive($, OTHER), false)
  assert.equal(await pidAlive($, 0), false, "a non-pid is never alive")
  assert.equal(await pidAlive($, -1), false)
  assert.equal(await pidAlive($, 1.5), false)
})

test("pidGone never concludes death from a signalable process", async () => {
  const { $, cmds } = fakeShell({ signalable: new Set([SELF, OTHER]), procPids: new Set([SELF]) })
  assert.equal(await pidGone($, OTHER), false)
  assert.equal(
    cmds.some((c) => c.startsWith("test -d")),
    false,
    "a live kill -0 short-circuits before the expensive probe",
  )
})

test("pidGone proves death through /proc once /proc/<self> validates the probe", async () => {
  // The target is unsignalable AND absent from /proc, and /proc works here.
  const { $ } = fakeShell({ signalable: new Set([SELF]), procPids: new Set([SELF]) })
  assert.equal(await pidGone($, OTHER), true)
})

test("pidGone refuses an EPERM process: unsignalable but present in /proc", async () => {
  // The exact false-takeover case. `kill -0` fails (another user's process) but
  // /proc still lists it — alive, so no takeover.
  const { $ } = fakeShell({ signalable: new Set([SELF]), procPids: new Set([SELF, OTHER]) })
  assert.equal(await pidGone($, OTHER), false, "another user's live process must never read as gone")
})

test("pidGone refuses when /proc is unavailable and ps cannot see our own pid", async () => {
  // Self-validation: a probe that cannot find US proves nothing about anyone.
  const noProbe = fakeShell({ signalable: new Set([SELF]) })
  assert.equal(await pidGone(noProbe.$, OTHER), false, "no /proc and no usable ps ⇒ not proven gone")

  const blindPs = fakeShell({ signalable: new Set([SELF]), psPids: new Set([]) })
  assert.equal(await pidGone(blindPs.$, OTHER), false, "a ps that omits our own pid is not evidence")
})

test("pidGone proves death through ps when it can see us but not the target", async () => {
  const { $ } = fakeShell({ signalable: new Set([SELF]), psPids: new Set([SELF]) })
  assert.equal(await pidGone($, OTHER), true)
})

test("pidGone refuses an EPERM process on the ps path too", async () => {
  const { $ } = fakeShell({ signalable: new Set([SELF]), psPids: new Set([SELF, OTHER]) })
  assert.equal(await pidGone($, OTHER), false)
})

test("machineId joins hostname with the boot id, and memoizes the read", async () => {
  resetMachineIdCache()
  const { $, cmds } = fakeShell({ bootId: "boot-abc" })
  assert.deepEqual(await machineId($), { host: os.hostname(), boot: "boot-abc" })
  await machineId($)
  assert.equal(cmds.filter((c) => c.includes("boot_id")).length, 1, "read once per process")
  resetMachineIdCache()
})

test("machineId degrades to hostname alone where the boot id is unreadable", async () => {
  resetMachineIdCache()
  const { $ } = fakeShell({ bootId: null })
  assert.deepEqual(await machineId($), { host: os.hostname(), boot: null })
  resetMachineIdCache()
})

test("isSameMachine fails closed on every unprovable comparison", () => {
  const self = { host: "box-a", boot: "boot-1" }
  assert.equal(isSameMachine({ host: "box-a", boot: "boot-1" }, self), true)
  assert.equal(isSameMachine({ host: "box-b", boot: "boot-1" }, self), false, "another host")
  assert.equal(isSameMachine({}, self), false, "an older stamp names no machine")
  assert.equal(isSameMachine({ host: "box-a" }, self), false, "same hostname, no boot id — sibling containers share hostnames")
  assert.equal(isSameMachine({ host: "box-a", boot: "boot-2" }, self), false, "a different container on one host")
  assert.equal(isSameMachine({ host: "box-a", boot: "boot-1" }, { host: "box-a", boot: null }), false, "we cannot place ourselves")
  assert.equal(isSameMachine({ host: "box-a", boot: "" }, self), false, "an empty token is not a match")
  assert.equal(isSameMachine({ host: "box-a" }, { host: "box-a", boot: null }), true, "neither side has a boot id — hostname is all there is")
})
