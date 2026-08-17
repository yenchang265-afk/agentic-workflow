import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * One invariant, over every shipped source file: no RAW C0 control character in
 * the text. Tab, newline and carriage return are the whole of the exception.
 *
 * The repo uses U+0000 as a map-key separator in a handful of template literals
 * (`deny-log.ts`'s kind+stage+command key, `verdict.ts`'s finding key,
 * `evidence.ts`, `osv-payload.ts`, the hub's metrics keys) — a good choice of
 * separator, written the wrong way: as the LITERAL character rather than as the
 * escape. git's text/binary heuristic sniffs a file's first 8000 bytes for a
 * NUL, so four of those files were classified BINARY at HEAD
 * (`packages/core/src/workflow/deny-log.ts`,
 * `packages/hub/src/server/metrics/{fanout,findings}.ts`,
 * `scripts/shell-glob.test.mjs`) — which means no reviewable diff (the commit
 * that introduced deny-log.ts reads `Bin 0 -> 8343 bytes`), and no textual
 * merge if one ever conflicts. The rest sat one edit away from the same cliff,
 * since it only takes the NUL moving earlier in the file.
 *
 * Written as the six-character escape instead, the key is byte-identical at
 * runtime and the file stays text — nothing about the keys changes, only how
 * they are spelled. This check is what stops the literal form coming back: it
 * is invisible in every editor, which is exactly why it went unnoticed across
 * seven files (and why writing THIS file re-introduced one on the first pass).
 *
 * Test files are NOT exempt, unlike `shell-glob.test.mjs`'s scan: a control
 * character is unreadable wherever it sits, and this file's sibling check was
 * itself one of the four offenders. A test that genuinely needs one writes the
 * escape too.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const ROOTS = ["packages", "plugins", "scripts"]
const SKIP_DIRS = new Set(["node_modules", "dist", ".claude", "build", "coverage"])

const sources = (dir) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...sources(path.join(dir, entry.name)))
      continue
    }
    if (!/\.(ts|mts|mjs|js|json)$/.test(entry.name)) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

/** Every raw control character in `src`, as `{ line, column, code }`. Pure. */
export const controlChars = (src) => {
  const found = []
  let line = 1
  let column = 1
  for (const ch of src) {
    const code = ch.codePointAt(0)
    if (ch === "\n") {
      line++
      column = 1
      continue
    }
    // Tab and CR are the only other characters below the printable range that
    // legitimately appear in source text.
    if (code < 0x20 ? ch !== "\t" && ch !== "\r" : code === 0x7f) {
      found.push({ line, column, code })
    }
    column++
  }
  return found
}

/** `U+0000` — how the offender is named, and how it should be written instead. */
const hex = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`

test("no shipped source carries a raw control character", () => {
  const offenders = []
  for (const root of ROOTS) {
    const dir = path.join(ROOT, root)
    if (!fs.existsSync(dir)) continue
    for (const file of sources(dir)) {
      const src = fs.readFileSync(file, "utf8")
      for (const { line, column, code } of controlChars(src)) {
        offenders.push(`${path.relative(ROOT, file)}:${line}:${column} — raw ${hex(code)}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "raw control characters in shipped sources — write them as an escape " +
      `(e.g. the six characters \\u0000) so git keeps the file textual:\n${offenders.join("\n")}`,
  )
})

test("the check sees a raw NUL and ignores tabs, newlines and escapes", () => {
  const raw = `const key = \`a${String.fromCharCode(0)}b\``
  assert.deepEqual(
    controlChars(raw).map((c) => c.code),
    [0],
    "a literal NUL must be seen",
  )
  assert.deepEqual(controlChars("a\tb\r\nc\n"), [], "tab, CR and newline are legitimate")
  assert.deepEqual(controlChars("const key = `a\\u0000b`"), [], "the escaped form must not be flagged")
  assert.equal(controlChars(`x${String.fromCharCode(0)}`)[0].line, 1)
  assert.equal(controlChars(`x\n\ny${String.fromCharCode(7)}`)[0].line, 3, "the line number is the offender's own")
})
