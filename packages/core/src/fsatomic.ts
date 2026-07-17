import type { Shell, ShellOutput } from "./host.js"

let seq = 0

/**
 * Write a file atomically: write to a same-directory temp file, then `mv`
 * (rename) it onto the target. Readers see either the old content or the new,
 * never a truncated file — a crash mid-write leaves only a stray temp file.
 * The temp lives next to the target so the `mv` stays a same-filesystem
 * rename(2). Returns the failing step's output so callers keep their own
 * throw-vs-best-effort policy.
 */
export const writeFileAtomic = async ($: Shell, dest: string, content: string): Promise<ShellOutput> => {
  const tmp = `${dest}.tmp-${process.pid}-${++seq}`
  const wrote = await $`printf '%s' ${content} > ${tmp}`.quiet().nothrow()
  if (wrote.exitCode !== 0) return wrote
  const moved = await $`mv ${tmp} ${dest}`.quiet().nothrow()
  if (moved.exitCode !== 0) await $`rm -f ${tmp}`.quiet().nothrow()
  return moved
}
