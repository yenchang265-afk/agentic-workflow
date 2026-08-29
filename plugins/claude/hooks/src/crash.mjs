/**
 * The fail-direction terminator for a hook entry point.
 *
 * A hook's last line is where its failure direction is CHOSEN rather than
 * defaulted to whatever the host does with a crashed process. Claude Code
 * treats a non-zero exit from an un-caught throw as a non-blocking error and
 * lets the turn proceed — which is fail-OPEN for every hook, including the
 * ones whose whole job is to fail closed. Two entry points already ended
 * `main().catch(() => allow())`; the rest ended with a bare `main()` and
 * inherited that default silently.
 *
 * Open is the RIGHT direction for the enforcement hooks — a false deny stalls a
 * run with no way out, while a false allow only restores the behaviour that
 * predates the control — but it must be a decision, and it must leave a trace:
 * before this there was no crash channel at all (the deny log records allowlist
 * refusals only), so a hook that threw on every call looked exactly like a hook
 * that had nothing to say.
 *
 * The exit is BOUNDED rather than either of the two shapes already in this
 * directory. `exitAfterWrite`'s rule — exit only in the write callback — exists
 * for payloads that ARE the contract (a JSON envelope, a block reason), and
 * this note is one too: it is the only trace a crashed hook leaves. But a write
 * callback that never fires (a closed or full stderr pipe) would park the hook
 * until the host's own 60s kill, which drops the whole envelope — the failure
 * this file exists to end, re-entered through its own remedy. So: exit in the
 * callback, and exit anyway on a short timer. The timer is `unref`ed, so a
 * process with nothing else pending still exits the moment the write lands.
 *
 * Dependency-free (no imports at all) so it bundles into any hook.
 */

/** One-line crash summary: message plus the first frame, never a whole stack. */
export const crashLine = (hook, err) => {
  const detail = err instanceof Error ? `${err.message} @ ${(err.stack ?? "").split("\n")[1]?.trim() ?? "?"}` : String(err)
  return `agentic-workflow: the ${hook} hook crashed and failed open — ${detail.replace(/\s+/g, " ").slice(0, 500)}`
}

/**
 * `main().catch(failOpen("<hook>"))` — record the crash, then exit 0 so the
 * tool call, prompt or session start proceeds as if the hook were not installed.
 */
export const failOpen = (hook) => (err) => {
  let done = false
  const exit = () => {
    if (done) return
    done = true
    process.exit(0)
  }
  // Never wait longer than this on a stream that may never drain. Unrefed so it
  // does not itself hold the process open once the write has landed.
  const timer = setTimeout(exit, 250)
  if (typeof timer.unref === "function") timer.unref()
  try {
    process.stderr.write(crashLine(hook, err) + "\n", exit)
  } catch {
    /* the diagnostic is best-effort; the exit code is the contract */
    exit()
  }
}
