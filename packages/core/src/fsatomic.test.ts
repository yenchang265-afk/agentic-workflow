import assert from "node:assert/strict"
import { test } from "node:test"
import { writeFileAtomic } from "./fsatomic.js"
import type { Shell } from "./host.js"

/**
 * Every durable write in the system funnels through `writeFileAtomic`, and it
 * had no test at all — which is how the 128 KiB argv ceiling went unnoticed on
 * the Claude host for as long as it did.
 *
 * The fake shell records commands and models `printf … > file` / `>> file` over
 * a file map, so both the temp-then-rename shape and the chunking are
 * observable. `MAX_ARG` mirrors Linux's MAX_ARG_STRLEN: a command longer than
 * this is what execve rejects with E2BIG, which the Claude shim surfaces as
 * exitCode 127 rather than a throw.
 */
const MAX_ARG = 128 * 1024

const makeShell = (opts: { failAt?: number; failMv?: boolean } = {}) => {
  const files: Record<string, string> = {}
  const cmds: string[] = []
  let writes = 0
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmds.push(cmd)
    let exitCode = 0
    const printf = /^printf '%s' ([\s\S]*) (>>?) (\S+)$/.exec(cmd)
    if (printf) {
      writes += 1
      if (opts.failAt === writes) exitCode = 1
      else {
        const [, content, redirect, dest] = printf as unknown as [string, string, string, string]
        files[dest] = redirect === ">>" ? (files[dest] ?? "") + content : content
      }
    } else if (cmd.startsWith("mv ")) {
      const [, src, dest] = cmd.split(/\s+/) as [string, string, string]
      if (opts.failMv) exitCode = 1
      else if (src in files) {
        files[dest] = files[src]!
        delete files[src]
      } else exitCode = 1
    } else if (cmd.startsWith("rm -f ")) {
      delete files[cmd.slice("rm -f ".length)]
    }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as Shell
  return { $, files, cmds }
}

test("a small write goes out in one printf, then renames into place", async () => {
  const { $, files, cmds } = makeShell()
  const r = await writeFileAtomic($, "/d/f.json", "hello")
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/f.json"], "hello")
  assert.equal(cmds.filter((c) => c.startsWith("printf")).length, 1, "no chunking for small content")
  assert.ok(cmds.some((c) => c.startsWith("mv ")), "the temp file is renamed, never written in place")
})

test("the temp file lives beside the destination so the mv stays a rename(2)", async () => {
  const { $, cmds } = makeShell()
  await writeFileAtomic($, "/d/f.json", "x")
  const mv = cmds.find((c) => c.startsWith("mv "))!
  const [, tmp, dest] = mv.split(/\s+/) as [string, string, string]
  assert.equal(tmp.slice(0, tmp.lastIndexOf("/")), dest.slice(0, dest.lastIndexOf("/")))
})

test("no single command approaches the argv ceiling, however large the payload", async () => {
  // THE regression test. The Claude host runs Shell as spawn("bash", ["-c", cmd]),
  // so the whole command is one argv entry and Linux caps it at MAX_ARG_STRLEN.
  // A 1 MiB state snapshot used to be passed as one word: execve returned E2BIG,
  // the shim reported exitCode 127, and saveState discarded the result — so long
  // runs silently stopped snapshotting.
  const { $, files, cmds } = makeShell()
  const big = "a".repeat(1024 * 1024)
  const r = await writeFileAtomic($, "/d/state.json", big)
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/state.json"], big, "every chunk lands, in order")
  for (const c of cmds) assert.ok(c.length < MAX_ARG, `a command of ${c.length} bytes would be rejected by execve`)
})

test("a payload of pure single quotes still fits, because escaping expands 4x", async () => {
  // `'` → `'\''` under shell escaping, so the chunk size has to leave headroom
  // for the worst case rather than the typical one.
  const { $, files, cmds } = makeShell()
  const quotes = "'".repeat(200 * 1024)
  await writeFileAtomic($, "/d/f", quotes)
  assert.equal(files["/d/f"], quotes)
  for (const c of cmds) assert.ok(c.length * 4 < MAX_ARG, "escaped worst case must still clear the ceiling")
})

test("a failed chunk aborts the write, cleans up, and leaves the destination untouched", async () => {
  const { $, files, cmds } = makeShell({ failAt: 2 })
  files["/d/f"] = "previous"
  const r = await writeFileAtomic($, "/d/f", "b".repeat(100 * 1024))
  assert.equal(r.exitCode, 1, "the failing step's output is returned, so callers keep their own policy")
  assert.equal(files["/d/f"], "previous", "readers never see a half-written file")
  assert.ok(cmds.some((c) => c.startsWith("rm -f ")), "the partial temp file is removed")
})

test("a failed rename removes the temp file rather than leaving it behind", async () => {
  const { $, files, cmds } = makeShell({ failMv: true })
  const r = await writeFileAtomic($, "/d/f", "x")
  assert.equal(r.exitCode, 1, "the mv's own failure is what the caller sees")
  assert.deepEqual(Object.keys(files), [], "no stray .tmp- file survives a failed rename")
  assert.ok(cmds.some((c) => c.startsWith("rm -f ")))
})
