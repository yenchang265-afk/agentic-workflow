import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Writable } from "node:stream"
import { exitAfterWrite } from "./src/emit.mjs"

/**
 * The flush contract: a hook must exit only in its stream's write callback.
 * `process.stdout` on a pipe is async, and `process.exit()` does not drain the
 * queue — an early exit truncates the JSON envelope and the host drops it
 * silently (a lost worktree-pin rewrite, a lost gate block). The mock stream
 * defers its callback, which exhibits the bug at ANY payload size — no 64KiB
 * repro needed, because the defect is "exit before callback", not "big payload".
 */
test("exitAfterWrite exits only after the stream's write callback fires", async () => {
  const realExit = process.exit
  const order = []
  let exited = null
  process.exit = (code) => {
    exited = code
    order.push("exit")
  }
  try {
    const stream = new Writable({
      write(_chunk, _enc, cb) {
        setImmediate(() => {
          order.push("flush")
          cb()
        })
      },
    })
    exitAfterWrite(stream, "payload", 2)
    assert.equal(exited, null, "must not exit before the async flush completes")
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
    assert.deepEqual(order, ["flush", "exit"], "exit strictly after flush")
    assert.equal(exited, 2, "the exit code rides through")
  } finally {
    process.exit = realExit
  }
})

// --- static regression scan: no hook ships the bare write-then-exit idiom ---

const HERE = path.dirname(fileURLToPath(import.meta.url))
const hookFiles = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => path.join(dir, f))

/**
 * The shape that loses payloads: a standalone `process.exit(N)` statement with a
 * stream `.write(` within the preceding few lines — the exact idiom every hook
 * used before emit.mjs. The fixed form puts the exit inside the write callback
 * (same line as the write), which this scan does not match.
 */
const bareWriteThenExit = (file) => {
  const lines = fs.readFileSync(file, "utf8").split("\n")
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*process\.exit\(\d+\)\s*;?\s*$/.test(lines[i])) continue
    const window = lines.slice(Math.max(0, i - 4), i).join("\n")
    if (/\.write\(/.test(window)) hits.push(`${file}:${i + 1}`)
  }
  return hits
}

test("no bundled or hand-written hook writes a stream and then exits outside the callback", () => {
  const files = [...hookFiles(HERE), ...hookFiles(path.join(HERE, "..", "..", "qwen", "hooks"))]
  assert.ok(files.length >= 10, `hook sweep looks wrong — only ${files.length} files found`)
  const offenders = files.flatMap(bareWriteThenExit)
  assert.deepEqual(offenders, [], "write-then-exit truncates the payload; route through src/emit.mjs exitAfterWrite")
})
