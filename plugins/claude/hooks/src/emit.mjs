/**
 * Exit-after-flush for hook processes.
 *
 * `process.stdout`/`process.stderr` on a pipe are ASYNC in Node, and
 * `process.exit()` does not drain the write queue — an exit right after a large
 * buffered write truncates the payload mid-stream. For a JSON envelope the host
 * then drops the malformed output silently: a worktree-pin `updatedInput`
 * (which carries the whole file content of a Write call) is lost and the write
 * lands where the agent originally aimed it, or a gate `decision: "block"`
 * vanishes and the model re-runs a verb the CLI already executed. For a block
 * reason on stderr the exit code still blocks, but the model reads a truncated
 * reason.
 *
 * So: exit ONLY in the stream's write callback. Every hook that writes before
 * exiting must go through this — hand-rolling `write(); exit()` is how the bug
 * comes back (it did; reconcile.entry.mjs was the only survivor).
 *
 * Dependency-free so it can be bundled into any hook.
 */
export const exitAfterWrite = (stream, payload, code) => {
  stream.write(payload, () => process.exit(code))
}
