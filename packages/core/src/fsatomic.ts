import type { Shell, ShellOutput } from "./host.js"

let seq = 0

/**
 * Largest payload written in a single `printf`. Content is interpolated as a
 * shell word, and the Claude host implements `Shell` as spawn("bash", ["-c", cmd]),
 * so the whole command lands in ONE argv entry — which Linux caps at
 * MAX_ARG_STRLEN (128 KiB) regardless of total ARG_MAX. Past that execve fails
 * with E2BIG, and the shim resolves that as exitCode 127 rather than throwing.
 *
 * 32 KiB leaves room for the worst case: single-quote escaping expands a byte
 * 4x (`'` → `'\''`), so even all-quotes content stays under the cap with the
 * rest of the command alongside it. Bigger payloads are appended in chunks.
 */
const SINGLE_SHOT_MAX = 32 * 1024

/** Append one chunk to `tmp`; the first truncates, the rest extend. */
const writeChunk = ($: Shell, tmp: string, chunk: string, first: boolean): PromiseLike<ShellOutput> =>
  first ? $`printf '%s' ${chunk} > ${tmp}`.quiet().nothrow() : $`printf '%s' ${chunk} >> ${tmp}`.quiet().nothrow()

/**
 * Write a file atomically: write to a same-directory temp file, then `mv`
 * (rename) it onto the target. Readers see either the old content or the new,
 * never a truncated file — a crash mid-write leaves only a stray temp file.
 * The temp lives next to the target so the `mv` stays a same-filesystem
 * rename(2). Returns the failing step's output so callers keep their own
 * throw-vs-best-effort policy.
 *
 * Content over `SINGLE_SHOT_MAX` is appended in chunks rather than passed as one
 * argv word — see that constant. The chunking is invisible to readers because
 * only the completed temp file is ever renamed into place; a chunk failing
 * partway leaves the destination untouched.
 */
export const writeFileAtomic = async ($: Shell, dest: string, content: string): Promise<ShellOutput> => {
  const tmp = `${dest}.tmp-${process.pid}-${++seq}`
  if (content.length <= SINGLE_SHOT_MAX) {
    const wrote = await writeChunk($, tmp, content, true)
    if (wrote.exitCode !== 0) return wrote
  } else {
    for (let i = 0; i < content.length; i += SINGLE_SHOT_MAX) {
      const wrote = await writeChunk($, tmp, content.slice(i, i + SINGLE_SHOT_MAX), i === 0)
      if (wrote.exitCode !== 0) {
        await $`rm -f ${tmp}`.quiet().nothrow()
        return wrote
      }
    }
  }
  const moved = await $`mv ${tmp} ${dest}`.quiet().nothrow()
  if (moved.exitCode !== 0) await $`rm -f ${tmp}`.quiet().nothrow()
  return moved
}
