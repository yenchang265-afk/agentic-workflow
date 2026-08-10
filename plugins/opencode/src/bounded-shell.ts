import type { Log, Shell, ShellOutput, ShellPromise } from "@agentic-workflow/core/host"

/**
 * A `Shell` that cannot wait forever.
 *
 * OpenCode's `$` is Bun's, which exposes no timeout of its own — `host.ts` says
 * so where it declares `ShellPromise.timeout` optional. That left every shell
 * call a gate verb makes unbounded, and unbounded here does not mean "slow": a
 * `workflow_gate` tool call spent 105 seconds inside one before a human pressed
 * ESC, and the next day never returned at all, with the task file already moved
 * and the model's turn wedged behind a tool that never answers. (The specific
 * command was a glob that should never have been one — see `claim-marker.ts` —
 * but "a gate move can hang forever" is the class, and the class outlives the
 * instance.)
 *
 * On expiry the call resolves like a FAILED command — exit `TIMEOUT_EXIT_CODE`
 * (124, `timeout(1)`'s convention, the same code `host.ts` specifies) — rather
 * than throwing. Every core caller already runs `.nothrow()` and branches on the
 * exit code, so a timeout degrades exactly like "git wasn't there": the gate
 * move still reports what it did, only the best-effort bookkeeping is skipped.
 * Throwing instead would turn a skipped `git add` into a failed approval.
 *
 * Nothing is cancelled — Bun gives no handle to kill the child, the same
 * residual `runChecks`' fallback documents. The abandoned promise is still
 * awaited internally, so a late rejection is never an unhandled one.
 *
 * Scope it to the GATE path only. Checkpoint commits, worktree creation and a
 * ship's `git push` + `gh pr create` are legitimately slow, and `runChecks`
 * carries its own (much longer) regime; a blanket wrap would cap those with a
 * number chosen for file moves.
 */

/** `timeout(1)`'s exit code for "the command was killed on the deadline". */
export const TIMEOUT_EXIT_CODE = 124

const output = (exitCode: number, stdout: string, stderr: string): ShellOutput => ({
  exitCode,
  stdout: { toString: () => stdout },
  stderr: { toString: () => stderr },
})

/**
 * Render a command the way the host would, for the warning. Interpolations are
 * substituted (they are paths and ids here — the point of the line is to name
 * WHICH call stalled), but never escaped: this string is logged, never run.
 */
const render = (strings: TemplateStringsArray, exprs: readonly unknown[]): string => {
  let cmd = ""
  strings.forEach((s, i) => {
    cmd += s
    if (i < exprs.length) {
      const e = exprs[i]
      cmd += Array.isArray(e) ? e.join(" ") : String(e)
    }
  })
  return cmd.trim().replace(/\s+/g, " ")
}

/**
 * Wrap `$` so every command it starts resolves within `ms`.
 *
 * The returned promise is lazy in the same way Bun's is not — the underlying
 * command has already started by the time we wrap it — but the chain
 * (`.quiet()`, `.nothrow()`, `.cwd()`, `.timeout()`) is preserved, because core
 * calls those on the value this returns and a missing method is a TypeError at
 * the worst possible moment. `.timeout(ms)` from a caller narrows the cap; it
 * can never widen it past the bound this exists to enforce.
 */
export const boundedShell = ($: Shell, ms: number, log: Log): Shell =>
  ((strings: TemplateStringsArray, ...exprs: unknown[]): ShellPromise => {
    // Reassigned rather than called for effect: a host whose `.quiet()` returns
    // a NEW promise instead of `this` would otherwise have its configuration
    // silently dropped, and the loop would inherit the raw stream.
    let inner = $(strings, ...exprs)
    let cap = ms

    const settle = async (): Promise<ShellOutput> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<ShellOutput | null>((resolve) => {
        timer = setTimeout(() => resolve(null), cap)
      })
      try {
        const raced = await Promise.race([
          Promise.resolve(inner).then(
            (v) => v,
            // A rejection is the shell's own (`.nothrow()` normally prevents
            // one); report it as a failed command rather than taking the caller
            // down — this wrapper must never add a failure mode of its own.
            (err: unknown) => output(1, "", (err as Error)?.message ?? String(err)),
          ),
          expiry,
        ])
        if (raced) return raced
        const cmd = render(strings, exprs)
        void log("warn", `shell command exceeded ${cap}ms and was abandoned (it may still be running): ${cmd}`)
        return output(TIMEOUT_EXIT_CODE, "", `timed out after ${cap}ms`)
      } finally {
        clearTimeout(timer)
      }
    }

    // One shared settlement: `.then` may be called more than once (a core helper
    // that awaits the same promise twice would otherwise start a second timer).
    let settled: Promise<ShellOutput> | undefined
    const run = (): Promise<ShellOutput> => (settled ??= settle())

    const wrapper: ShellPromise = {
      quiet: () => {
        inner = inner.quiet()
        return wrapper
      },
      nothrow: () => {
        inner = inner.nothrow()
        return wrapper
      },
      cwd: (dir: string) => {
        inner = inner.cwd(dir)
        return wrapper
      },
      timeout: (n: number) => {
        cap = Math.min(cap, n)
        return wrapper
      },
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    }
    return wrapper
  }) as Shell
