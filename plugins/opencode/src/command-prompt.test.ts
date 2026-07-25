import assert from "node:assert/strict"
import { test } from "node:test"
import { overrideCommandPrompt, readCommandPrompt, refusalPrompt } from "./command-prompt.ts"

/**
 * opencode renders a `/agentic-workflow:*` command markdown whether or not the
 * plugin handled it. When the plugin refuses (kind not enabled, core build
 * stale) the template must be REPLACED — left in place, it reads to the model
 * as instructions to go poll PRs, call `gh`, and guess at `watch`/`claim`.
 */

const textPart = (text: string) => ({ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text })

test("the rendered template is replaced, not appended to", () => {
  const output = { parts: [textPart("The PR sitter agentic loop — poll the configured PR source…")] }
  overrideCommandPrompt(output, "REFUSED")
  assert.equal(output.parts[0]!.text, "REFUSED")
})

test("trailing text parts are blanked so no slice of the template survives", () => {
  const output = { parts: [textPart("body"), textPart("watch"), textPart("more template")] }
  overrideCommandPrompt(output, "REFUSED")
  assert.deepEqual(
    output.parts.map((p) => p.text),
    ["REFUSED", "", ""],
  )
})

test("non-text parts are left untouched", () => {
  const file = { id: "prt_2", sessionID: "ses_1", messageID: "msg_1", type: "file", filename: "a.ts" }
  const output = { parts: [file, textPart("body")] as Array<Record<string, unknown>> }
  overrideCommandPrompt(output as never, "REFUSED")
  assert.equal(file.filename, "a.ts", "a file part must not be mangled")
  assert.equal(output.parts[1]!.text, "REFUSED")
})

test("a malformed or absent payload never throws (a refusal must not kill the turn)", () => {
  // opencode owns this object; the existing hook tests already pass `{}`.
  assert.doesNotThrow(() => overrideCommandPrompt(undefined, "x"))
  assert.doesNotThrow(() => overrideCommandPrompt({}, "x"))
  assert.doesNotThrow(() => overrideCommandPrompt({ parts: [] }, "x"))
  assert.doesNotThrow(() => overrideCommandPrompt({ parts: [null, undefined] }, "x"))
  assert.doesNotThrow(() => overrideCommandPrompt({ parts: undefined }, "x"))
})

test("the rendered body is read back whole, so a split template can still be sliced", () => {
  const output = { parts: [textPart("<!-- aw:shared -->\nrules\n"), textPart("<!-- /aw:shared -->")] }
  // Joined bare: the parts are one template opencode split, not separate
  // messages, so anything inserted between them would corrupt a marker line.
  assert.equal(readCommandPrompt(output), "<!-- aw:shared -->\nrules\n<!-- /aw:shared -->")
})

test("reading a malformed, absent, or textless payload yields undefined rather than throwing", () => {
  for (const payload of [undefined, {}, { parts: [] }, { parts: [null, undefined] }, { parts: undefined }]) {
    assert.doesNotThrow(() => readCommandPrompt(payload))
    assert.equal(readCommandPrompt(payload), undefined)
  }
  const fileOnly = { parts: [{ id: "p", sessionID: "s", messageID: "m", type: "file", filename: "a.ts" }] }
  assert.equal(readCommandPrompt(fileOnly as never), undefined, "a file-only payload has no body to slice")
})

test("the refusal prompt forbids the improvisation it exists to stop", () => {
  const prompt = refusalPrompt('the workflow kind "pr-sitter" is not enabled.', "Enable it in .agentic-workflow.json.")
  assert.match(prompt, /did NOT run this command/)
  assert.match(prompt, /not instructions for you/)
  assert.match(prompt, /do not run git\/gh\/az or call any API/)
  assert.match(prompt, /do not start, watch, or claim anything/)
  assert.match(prompt, /Enable it in \.agentic-workflow\.json\./, "the remedy must reach the model verbatim")
})
