import assert from "node:assert/strict"
import { test } from "node:test"
import type { Shell, ShellOutput, ShellPromise } from "@agentic-workflow/core/host"
import { boundedShell, TIMEOUT_EXIT_CODE } from "./bounded-shell.ts"

/**
 * The wrapper that keeps a gate verb's shell work from waiting forever.
 *
 * Written against the one behaviour every caller in core depends on: a command
 * that fails is an exit CODE, never a throw. A timeout that threw instead would
 * turn a skipped `git add` into a failed approval — the opposite of the point.
 */

/** A fake `$` whose settlement each test controls, recording what was configured. */
const makeShell = (settle: (cmd: string) => Promise<ShellOutput> | null) => {
  const calls: string[] = []
  const config: string[] = []
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]): ShellPromise => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    calls.push(cmd)
    // `null` models a command that never settles — the whole failure mode.
    const promise = settle(cmd) ?? new Promise<ShellOutput>(() => {})
    const self: ShellPromise = {
      quiet: () => (config.push("quiet"), self),
      nothrow: () => (config.push("nothrow"), self),
      cwd: (dir) => (config.push(`cwd:${dir}`), self),
      then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
    }
    return self
  }) as Shell
  return { $, calls, config }
}

const ok = (stdout = ""): ShellOutput => ({ exitCode: 0, stdout: { toString: () => stdout }, stderr: { toString: () => "" } })

test("a command that never settles resolves 124 at the cap instead of hanging", async () => {
  const warnings: string[] = []
  const { $ } = makeShell(() => null)
  const bounded = boundedShell($, 20, async (level, message) => {
    if (level === "warn") warnings.push(message)
  })

  const out = await bounded`git add -- ${"docs/tasks"}`.quiet().nothrow()

  assert.equal(out.exitCode, TIMEOUT_EXIT_CODE, "core reads the exit code, so a timeout must look like a failed command")
  assert.match(out.stderr.toString(), /timed out/)
  // The whole reason the last one of these took a forensic session to find.
  assert.ok(
    warnings.some((w) => w.includes("git add -- docs/tasks")),
    `the warning must name the command that stalled, got: ${warnings.join(" | ")}`,
  )
})

test("a normal command passes through untouched", async () => {
  const { $, calls, config } = makeShell(() => Promise.resolve(ok("main")))
  const bounded = boundedShell($, 1_000, async () => {})

  const out = await bounded`git -C ${"/repo"} rev-parse --abbrev-ref HEAD`.quiet().nothrow().cwd("/repo")

  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout.toString(), "main")
  assert.deepEqual(calls, ["git -C /repo rev-parse --abbrev-ref HEAD"])
  // The chain must reach the real shell: a dropped `.quiet()` would leak a
  // stage's output into the transcript, a dropped `.cwd()` would run elsewhere.
  assert.deepEqual(config, ["quiet", "nothrow", "cwd:/repo"])
})

test("a rejecting command is reported as a failure, never rethrown", async () => {
  const { $ } = makeShell(() => Promise.reject(new Error("spawn EAGAIN")))
  const bounded = boundedShell($, 1_000, async () => {})

  const out = await bounded`mv ${"a"} ${"b"}`.quiet().nothrow()

  assert.equal(out.exitCode, 1)
  assert.match(out.stderr.toString(), /EAGAIN/)
})

test("a caller's own timeout narrows the cap but can never widen it", async () => {
  const { $ } = makeShell(() => null)
  const bounded = boundedShell($, 60_000, async () => {})
  const started = Date.now()

  const narrowed = await bounded`sleep 1`.quiet().nothrow().timeout?.(20)
  assert.equal(narrowed?.exitCode, TIMEOUT_EXIT_CODE)
  assert.ok(Date.now() - started < 5_000, "the caller's shorter deadline must win")

  const widened = await boundedShell($, 20, async () => {})`sleep 1`.quiet().nothrow().timeout?.(60_000)
  assert.equal(widened?.exitCode, TIMEOUT_EXIT_CODE, "the bound exists to be a ceiling")
})

test("awaiting the same command twice does not start a second deadline", async () => {
  const { $ } = makeShell(() => null)
  let warned = 0
  const bounded = boundedShell($, 20, async (level) => {
    if (level === "warn") warned++
  })

  const promise = bounded`test -f ${"x"}`.quiet().nothrow()
  const [a, b] = await Promise.all([promise, promise])

  assert.equal(a.exitCode, TIMEOUT_EXIT_CODE)
  assert.equal(b.exitCode, TIMEOUT_EXIT_CODE)
  assert.equal(warned, 1, "one command, one warning — a second settlement would double-report")
})
