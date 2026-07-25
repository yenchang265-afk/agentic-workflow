import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { commandPromptVerbs, sliceCommandPrompt } from "./command-slice.ts"

/**
 * The command hook trims a rendered body to the invoked verb before the model
 * sees it. Two properties carry the design: shared prose is the COMPLEMENT of
 * the markers (so prose added later is kept by default and can never be
 * silently dropped from a verb), and anything the markup does not understand
 * falls back to the FULL body (a partial slice would drop instructions while
 * still looking like a complete prompt).
 */

const BODY = [
  "preamble",
  "",
  "## Authoring",
  "",
  "<!-- aw:verb new -->",
  "new instructions",
  "<!-- /aw:verb new -->",
  "<!-- aw:verb stop|abort -->",
  "stop instructions",
  "<!-- /aw:verb stop|abort -->",
  "",
  "hard rules",
  "",
  "## Introspection",
  "",
  "<!-- aw:verb status -->",
  "status instructions",
  "<!-- /aw:verb status -->",
].join("\n")

test("a slice is the shared text plus the invoked verb's block, in source order", () => {
  assert.equal(sliceCommandPrompt(BODY, "new"), "preamble\n\n## Authoring\n\nnew instructions\n\nhard rules")
})

test("text outside every marker is always kept — shared is the complement, not a marker", () => {
  for (const verb of ["new", "stop", "status"]) {
    const slice = sliceCommandPrompt(BODY, verb)!
    assert.match(slice, /preamble/, `${verb} keeps the preamble`)
    assert.match(slice, /hard rules/, `${verb} keeps the hard rules`)
  }
})

test("another verb's block never leaks into the slice", () => {
  const slice = sliceCommandPrompt(BODY, "new")!
  assert.doesNotMatch(slice, /stop instructions/)
  assert.doesNotMatch(slice, /status instructions/)
})

test("a heading the slice emptied is dropped, so no section promises prose that is gone", () => {
  // `new` empties "## Introspection"; the heading must go with it.
  assert.doesNotMatch(sliceCommandPrompt(BODY, "new")!, /## Introspection/)
  assert.match(sliceCommandPrompt(BODY, "status")!, /## Introspection/)
})

test("emptied headings collapse transitively, not just one level", () => {
  // Slicing for `y` empties B, which leaves A with nothing but B under it — so
  // dropping B has to make A droppable in the same pass.
  const body = [
    "<!-- aw:verb y -->",
    "y",
    "<!-- /aw:verb y -->",
    "",
    "## A",
    "",
    "## B",
    "",
    "<!-- aw:verb x -->",
    "x",
    "<!-- /aw:verb x -->",
  ].join("\n")
  assert.equal(sliceCommandPrompt(body, "y"), "y")
})

test("a heading is kept when shared prose sits under it — that prose is its section", () => {
  // The complement model means unmarked text after a heading belongs to it, so
  // the heading is not empty even when every verb block under it is dropped.
  assert.match(sliceCommandPrompt(BODY, "status")!, /## Authoring/)
})

test("one block can serve a verb and its alias", () => {
  assert.match(sliceCommandPrompt(BODY, "stop")!, /stop instructions/)
  assert.match(sliceCommandPrompt(BODY, "abort")!, /stop instructions/)
})

test("markers never reach the model", () => {
  for (const verb of ["new", "stop", "status"]) assert.doesNotMatch(sliceCommandPrompt(BODY, verb)!, /aw:verb/)
})

test("a bare command (no argument) slices as status, which is what it runs", () => {
  assert.match(sliceCommandPrompt(BODY, "")!, /status instructions/)
  assert.match(sliceCommandPrompt(BODY, "   ")!, /status instructions/)
})

test("the verb is matched case-insensitively, as the hook lowercases it", () => {
  assert.equal(sliceCommandPrompt(BODY, "NEW"), sliceCommandPrompt(BODY, "new"))
})

test("an unknown verb keeps the full body — never a shared-only slice", () => {
  // Shared text alone would hand the model rules and no task. The hook replaces
  // an unknown verb's template with the usage string anyway.
  assert.equal(sliceCommandPrompt(BODY, "bogus"), undefined)
})

test("an unmarked body keeps the full body", () => {
  assert.equal(sliceCommandPrompt("just prose, no markers at all", "new"), undefined)
})

test("broken markup keeps the full body rather than shipping half of it", () => {
  const cases = {
    unclosed: "<!-- aw:verb new -->\nx",
    "stray close": "x\n<!-- /aw:verb new -->",
    nested: "<!-- aw:verb new -->\n<!-- aw:verb old -->\nx\n<!-- /aw:verb old -->\n<!-- /aw:verb new -->",
    "mismatched close": "<!-- aw:verb new -->\nx\n<!-- /aw:verb old -->",
  }
  for (const [name, body] of Object.entries(cases)) {
    assert.equal(sliceCommandPrompt(body, "new"), undefined, name)
    assert.deepEqual(commandPromptVerbs(body), [], `${name}: broken markup covers no verb`)
  }
})

test("a marker inside a line of prose is inert, because markers must own their line", () => {
  // $ARGUMENTS is substituted into the body before the plugin sees it, so the
  // user's idea text reaches the slicer as markup. The command renders it as
  // `**$ARGUMENTS**`, so an injected marker is never alone on its line and
  // cannot open or close anything — it stays literal text.
  const body = BODY.replace("preamble", "**new fix the <!-- /aw:verb new --> parser**")
  const slice = sliceCommandPrompt(body, "new")
  assert.match(slice!, /new instructions/, "the slice still happens")
  assert.match(slice!, /fix the <!-- \/aw:verb new --> parser/, "the argument text survives verbatim")
})

test("a whole-line marker injected by a multi-line argument costs the trim, not the instructions", () => {
  // A pasted multi-line idea CAN put a bare marker on its own line. That
  // unbalances the file, and the only consequence must be the full body.
  const body = BODY.replace("preamble", "**new fix\n<!-- /aw:verb new -->\nthe parser**")
  assert.equal(sliceCommandPrompt(body, "new"), undefined)
})

/**
 * The coverage guard. A verb that loses its block does not fail loudly — it
 * silently falls back to the full 200+ line body, which is exactly the
 * regression this change exists to prevent. So derive the verb list from the
 * command's own `argument-hint` and assert every one is marked up.
 */
const commandFile = (name: string) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "commands", `${name}.md`), "utf8")

/**
 * The verbs a command advertises: the leading token of each top-level
 * `|`-separated form in `argument-hint`. The split must respect brackets —
 * `watch [poll [interval] | cron <schedule> | idle]` is ONE form whose inner
 * alternatives are trigger arguments, not verbs.
 */
export const advertisedVerbs = (body: string): string[] => {
  const hint = /^argument-hint:\s*(.+)$/m.exec(body)
  assert.ok(hint, "the command must declare an argument-hint for the guard to read")
  const forms: string[] = []
  let depth = 0
  let current = ""
  for (const ch of hint[1]!) {
    if (ch === "[" || ch === "<") depth++
    else if (ch === "]" || ch === ">") depth--
    if (ch === "|" && depth === 0) {
      forms.push(current)
      current = ""
      continue
    }
    current += ch
  }
  forms.push(current)
  return [...new Set(forms.map((form) => form.trim().split(/[\s<[]/)[0]!.trim()).filter(Boolean))]
}

test("the argument-hint split respects brackets, so trigger arguments are not read as verbs", () => {
  const body = commandFile("agentic-workflow-engineering")
  const verbs = advertisedVerbs(body)
  assert.ok(verbs.includes("watch"), "watch is a verb")
  for (const notAVerb of ["cron", "idle", "poll", "interval"]) {
    assert.ok(!verbs.includes(notAVerb), `${notAVerb} is an argument of watch, not a verb`)
  }
})

test("every verb the engineering command advertises has a block to slice to", () => {
  const body = commandFile("agentic-workflow-engineering")
  const covered = commandPromptVerbs(body)
  const missing = advertisedVerbs(body).filter((verb) => !covered.includes(verb))
  assert.deepEqual(missing, [], "add an <!-- aw:verb … --> block, or these verbs silently get the whole body")
})

test("every marked verb is one the engineering command advertises", () => {
  const body = commandFile("agentic-workflow-engineering")
  // `abort` is documented in the body as an alias of `stop`, not in the hint.
  const extra = commandPromptVerbs(body).filter((verb) => ![...advertisedVerbs(body), "abort"].includes(verb))
  assert.deepEqual(extra, [], "a marker naming an unknown verb is dead weight or a typo")
})

test("the engineering command's markers are balanced in the shipped file", () => {
  // Without this, a marker typo degrades to "always send the full body" —
  // correct, but invisible, and it would quietly undo the whole change.
  assert.notDeepEqual(commandPromptVerbs(commandFile("agentic-workflow-engineering")), [])
})

test("every advertised engineering verb slices to well under the whole body", () => {
  const body = commandFile("agentic-workflow-engineering")
  const full = body.split("\n").length
  for (const verb of [...advertisedVerbs(body), "abort"]) {
    const slice = sliceCommandPrompt(body, verb)
    assert.ok(slice, `${verb} must slice`)
    const lines = slice.split("\n").length
    assert.ok(lines < full / 2, `${verb} slices to ${lines} of ${full} lines — expected less than half`)
  }
})

test("the shared prohibition on touching docs/tasks survives every slice", () => {
  const body = commandFile("agentic-workflow-engineering")
  for (const verb of [...advertisedVerbs(body), "abort"]) {
    assert.match(sliceCommandPrompt(body, verb)!, /Never move, create, or delete files under/, verb)
  }
})

test("the aliases the engineering command documents outside argument-hint still slice", () => {
  const body = commandFile("agentic-workflow-engineering")
  assert.equal(sliceCommandPrompt(body, "abort"), sliceCommandPrompt(body, "stop"))
})
