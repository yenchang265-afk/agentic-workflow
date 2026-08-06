import type { Shell, ShellOutput } from "./host.js"

let seq = 0

/**
 * Largest payload written in a single `printf`. Content is interpolated as a
 * shell word, and the Claude host implements `Shell` as spawn("bash", ["-c", cmd]),
 * so the whole command lands in ONE argv entry — which Linux caps at
 * MAX_ARG_STRLEN (128 KiB) regardless of total ARG_MAX. Past that execve fails
 * with E2BIG, and the shim resolves that as exitCode 127 rather than throwing.
 *
 * The bound has to hold for the WORST case, not the typical one: single-quote
 * escaping expands a byte 4x (`'` → `'\''`), so a chunk of pure quotes costs
 * 4 × its size. 32 KiB would land exactly on the 128 KiB ceiling before the
 * `printf '%s' … > <path>` wrapper is even counted; 16 KiB leaves half the
 * budget spare. Bigger payloads are appended in chunks.
 */
const SINGLE_SHOT_MAX = 16 * 1024

/** Append one chunk to `tmp`; the first truncates, the rest extend. */
const writeChunk = ($: Shell, tmp: string, chunk: string, first: boolean): PromiseLike<ShellOutput> =>
  first ? $`printf '%s' ${chunk} > ${tmp}`.quiet().nothrow() : $`printf '%s' ${chunk} >> ${tmp}`.quiet().nothrow()

/**
 * The end offset of the chunk starting at `from` — `SINGLE_SHOT_MAX` code
 * units, stepped back by one when that would land between a surrogate pair.
 *
 * `slice` cuts on UTF-16 code units, but each chunk is encoded to UTF-8
 * independently on its way to the shell. A pair split across two chunks becomes
 * two lone surrogates, each encoded to U+FFFD — silent, permanent corruption of
 * a durable artifact, reported with exitCode 0. Stepping back never grows a
 * chunk, so the argv-ceiling argument above still holds.
 */
const chunkEnd = (content: string, from: number): number => {
  const end = Math.min(from + SINGLE_SHOT_MAX, content.length)
  if (end >= content.length) return end
  const code = content.charCodeAt(end - 1)
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end // high surrogate last ⇒ its low half is in the next chunk
}

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
 *
 * `noClobber` renames with `mv -n`, for the callers that are CREATING a file
 * rather than replacing one — where landing on top of an existing file destroys
 * somebody else's content instead of superseding your own. Because `mv -n` onto
 * an existing target is a successful no-op, the temp surviving the rename is the
 * only signal the destination was taken; that is reported as a non-zero
 * `ShellOutput` so an existing caller's error path covers it unchanged. Default
 * off — replacing IS the point everywhere else.
 */
/**
 * Append `text` to `dest` in argv-safe chunks — the append-side twin of
 * `writeFileAtomic`'s chunk loop, for callers whose semantic is `>>`.
 *
 * The task-store append helpers (`appendRunLog`, `appendPlan`, `appendNote`)
 * used to pass their whole payload as ONE printf argument. A stage transcript
 * routinely exceeds MAX_ARG_STRLEN on the spawn("bash",["-c"]) hosts — execve
 * fails E2BIG, the shim reports exit 127, and the durable run-log section was
 * silently missing from the record. Same surrogate-pair-safe chunking as the
 * atomic writer; no temp+rename because appending to the live file IS the
 * semantic, and a failure partway leaves a prefix — the same failure shape a
 * plain `>>` already had, now merely bounded per chunk. Returns the failing
 * chunk's output, or the last chunk's on success.
 */
export const appendFileChunked = async ($: Shell, dest: string, content: string): Promise<ShellOutput> => {
  let out: ShellOutput | null = null
  for (let i = 0; i < content.length || out === null; ) {
    const end = chunkEnd(content, i)
    out = await $`printf '%s' ${content.slice(i, end)} >> ${dest}`.quiet().nothrow()
    if (out.exitCode !== 0) return out
    i = end
    if (content.length === 0) break // empty append still touches the file once
  }
  return out
}

export const writeFileAtomic = async (
  $: Shell,
  dest: string,
  content: string,
  opts: { readonly noClobber?: boolean } = {},
): Promise<ShellOutput> => {
  const tmp = `${dest}.tmp-${process.pid}-${++seq}`
  if (content.length <= SINGLE_SHOT_MAX) {
    const wrote = await writeChunk($, tmp, content, true)
    if (wrote.exitCode !== 0) {
      // The chunked branch and the rename below both clean up; this one used to
      // return straight out, leaving `<dest>.tmp-<pid>-<n>` beside the file
      // forever. Every small durable write lands here.
      await $`rm -f ${tmp}`.quiet().nothrow()
      return wrote
    }
  } else {
    for (let i = 0; i < content.length; ) {
      const end = chunkEnd(content, i)
      const wrote = await writeChunk($, tmp, content.slice(i, end), i === 0)
      if (wrote.exitCode !== 0) {
        await $`rm -f ${tmp}`.quiet().nothrow()
        return wrote
      }
      i = end
    }
  }
  const moved = opts.noClobber ? await $`mv -n ${tmp} ${dest}`.quiet().nothrow() : await $`mv ${tmp} ${dest}`.quiet().nothrow()
  if (moved.exitCode !== 0) {
    await $`rm -f ${tmp}`.quiet().nothrow()
    return moved
  }
  if (opts.noClobber) {
    const lost = await $`test -e ${tmp}`.quiet().nothrow()
    if (lost.exitCode === 0) {
      await $`rm -f ${tmp}`.quiet().nothrow()
      return { ...moved, exitCode: 1, stderr: { toString: () => `${dest} already exists` } } as ShellOutput
    }
  }
  return moved
}
