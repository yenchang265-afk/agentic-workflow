import assert from "node:assert/strict"
import { test } from "node:test"
import { splitVerb } from "./verb.ts"

/**
 * splitVerb must read the verb exactly the way opencode's `$1` placeholder
 * renders it (quote-aware first token, surrounding quotes trimmed) — the
 * rendered `Verb:` line and the plugin's dispatch have to agree on what was
 * invoked. `rest` stays raw: payloads are literal user text.
 */

test("plain verb and remainder", () => {
  assert.deepEqual(splitVerb("new add a status dashboard"), { verb: "new", rest: "add a status dashboard" })
})

test("bare verb has an empty rest", () => {
  assert.deepEqual(splitVerb("status"), { verb: "status", rest: "" })
})

test("a quoted verb dispatches as its unquoted self, like $1 renders it", () => {
  assert.deepEqual(splitVerb("'new' fix the parser"), { verb: "new", rest: "fix the parser" })
  assert.deepEqual(splitVerb('"status"'), { verb: "status", rest: "" })
})

test("quotes inside the payload are preserved — rest is raw text", () => {
  assert.deepEqual(splitVerb("new 'add quotes' feature"), { verb: "new", rest: "'add quotes' feature" })
})

test("verb is lowercased and surrounding whitespace trimmed", () => {
  assert.deepEqual(splitVerb("  APPROVE abc "), { verb: "approve", rest: "abc" })
})

test("empty and whitespace-only input yield the empty split", () => {
  assert.deepEqual(splitVerb(""), { verb: "", rest: "" })
  assert.deepEqual(splitVerb("   "), { verb: "", rest: "" })
})

test("a multi-word quoted first token is one (unknown) verb — host parity", () => {
  // opencode's tokenizer reads `"new idea"` as ONE token, so $1 renders
  // `new idea`. Splitting on whitespace instead would dispatch `new` with a
  // mangled payload while the rendered Verb: line says otherwise.
  assert.deepEqual(splitVerb('"new idea" x'), { verb: "new idea", rest: "x" })
})
