import assert from "node:assert/strict"
import { test } from "node:test"
import { appendFileChunked, writeFileAtomic } from "./fsatomic.js"
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
        // Each chunk crosses the process boundary as UTF-8 BYTES and is
        // appended to the file as bytes — so encode per chunk and concatenate
        // buffers rather than joining JS strings. A lone surrogate left by a
        // bad split encodes to U+FFFD here exactly as it would in a real
        // shell; string concatenation would silently heal it and hide the bug.
        const bytes = Buffer.concat([
          redirect === ">>" ? Buffer.from(files[dest] ?? "", "utf8") : Buffer.alloc(0),
          Buffer.from(content, "utf8"),
        ])
        files[dest] = bytes.toString("utf8")
      }
    } else if (cmd.startsWith("mv ")) {
      const parts = cmd.split(/\s+/)
      // `mv -n` onto an existing destination is a SUCCESSFUL no-op that leaves the
      // source alone — modelled exactly, because that asymmetry is the whole
      // reason `noClobber` has to probe for the surviving temp file afterwards.
      const noClobber = parts.includes("-n")
      const [src, dest] = parts.slice(1).filter((p) => !p.startsWith("-")) as [string, string]
      if (opts.failMv) exitCode = 1
      else if (noClobber && dest in files) exitCode = 0
      else if (src in files) {
        files[dest] = files[src]!
        delete files[src]
      } else exitCode = 1
    } else if (cmd.startsWith("test -e ")) {
      exitCode = cmd.slice("test -e ".length) in files ? 0 : 1
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

test("appendFileChunked lands a 200 KiB append intact with no command near the argv ceiling", async () => {
  // THE run-log regression. appendRunLog passed a whole stage transcript as one
  // printf argument; past MAX_ARG_STRLEN execve fails E2BIG, the shim reports
  // exit 127, and the durable record's section silently vanished.
  const { $, files, cmds } = makeShell()
  files["/d/runs/t.md"] = "## earlier section\n"
  const big = "x".repeat(200 * 1024)
  const r = await appendFileChunked($, "/d/runs/t.md", `\n## review\n\n${big}\n`)
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/runs/t.md"], `## earlier section\n\n## review\n\n${big}\n`, "appended after the existing content, byte-identical")
  for (const c of cmds) assert.ok(c.length < MAX_ARG, `a command of ${c.length} bytes would be rejected by execve`)
})

test("appendFileChunked survives quote-heavy content — the 4x escaping worst case", async () => {
  const { $, files, cmds } = makeShell()
  const quotes = "'".repeat(100 * 1024)
  const r = await appendFileChunked($, "/d/f", quotes)
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/f"], quotes)
  for (const c of cmds) assert.ok(c.length * 4 < MAX_ARG, "escaped worst case must still clear the ceiling")
})

test("appendFileChunked never splits a surrogate pair across chunks", async () => {
  const { $, files } = makeShell()
  // Enough astral characters to force several chunk boundaries.
  const emoji = "🙂".repeat(40 * 1024)
  await appendFileChunked($, "/d/f", emoji)
  assert.equal(files["/d/f"], emoji, "no U+FFFD from a torn pair")
})

test("appendFileChunked reports a failed chunk instead of pretending the append landed", async () => {
  const { $, files } = makeShell({ failAt: 2 })
  files["/d/f"] = "prefix"
  const r = await appendFileChunked($, "/d/f", "b".repeat(100 * 1024))
  assert.equal(r.exitCode, 1, "the failing chunk's output reaches the caller (warnLostAppend)")
  assert.ok(files["/d/f"]!.startsWith("prefix"), "an append failure leaves a bounded prefix — the same shape a plain >> had")
})

test("an empty append still touches the file once", async () => {
  const { $, files, cmds } = makeShell()
  const r = await appendFileChunked($, "/d/f", "")
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/f"], "")
  assert.equal(cmds.filter((c) => c.startsWith("printf")).length, 1)
})

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

test("noClobber refuses to land on an existing file, and cleans up after itself", async () => {
  // For callers that are CREATING a file rather than replacing one, landing on
  // top of an existing file destroys somebody else's content. `mv -n` prevents
  // that but reports success, so the surviving temp is the only signal.
  const { $, files, cmds } = makeShell()
  files["/d/f"] = "somebody else's task"
  const r = await writeFileAtomic($, "/d/f", "mine", { noClobber: true })
  assert.equal(r.exitCode, 1, "the caller's existing error path covers the lost race")
  assert.match(r.stderr.toString(), /already exists/)
  assert.equal(files["/d/f"], "somebody else's task", "the other file is untouched")
  assert.deepEqual(
    Object.keys(files).filter((f) => f.includes(".tmp-")),
    [],
    "no stray temp file survives",
  )
  assert.ok(cmds.some((c) => c.startsWith("mv -n ")))
})

test("noClobber still writes normally when the destination is free", async () => {
  const { $, files } = makeShell()
  const r = await writeFileAtomic($, "/d/f", "mine", { noClobber: true })
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/f"], "mine")
})

test("a failed single-shot write also cleans up its temp file", async () => {
  // The chunked path and the rename both cleaned up; the single-shot path
  // returned early and left `<dest>.tmp-<pid>-<n>` beside the task file
  // forever. Every small durable write — task notes, state, ledgers — takes
  // this branch.
  const { $, files, cmds } = makeShell({ failAt: 1 })
  files["/d/f"] = "previous"
  const r = await writeFileAtomic($, "/d/f", "small")
  assert.equal(r.exitCode, 1)
  assert.deepEqual(Object.keys(files), ["/d/f"], "no stray .tmp- file survives")
  assert.equal(files["/d/f"], "previous", "and the destination is untouched")
  assert.ok(cmds.some((c) => c.startsWith("rm -f ")), "the temp file is removed")
})

test("chunking never splits a surrogate pair", async () => {
  // `slice` cuts on UTF-16 code units. An astral character straddling a chunk
  // boundary became two lone surrogates, each encoded to UTF-8 separately for
  // the shell argument — two U+FFFD in a durable run log, reported as success.
  const { $, files } = makeShell()
  const pad = "a".repeat(16 * 1024 - 1) // leaves the boundary mid-pair
  const content = `${pad}😀${"b".repeat(40 * 1024)}`
  const r = await writeFileAtomic($, "/d/log.md", content)
  assert.equal(r.exitCode, 0)
  assert.equal(files["/d/log.md"], content, "the emoji survives the chunk boundary intact")
  assert.ok(!(files["/d/log.md"] ?? "").includes("�"), "no replacement characters")
})

test("chunking still respects the argv ceiling when it steps back off a pair", async () => {
  const { $, files, cmds } = makeShell()
  // Every boundary lands mid-pair, the worst case for a naive step-back.
  const content = "😀".repeat(100 * 1024)
  await writeFileAtomic($, "/d/f", content)
  assert.equal(files["/d/f"], content)
  for (const c of cmds) assert.ok(c.length < MAX_ARG, `a command of ${c.length} bytes would be rejected by execve`)
})
