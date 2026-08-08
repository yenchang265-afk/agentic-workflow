import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { commandPromptVerbs, neutralizeArgumentMarkers, sliceCommandPrompt } from "./command-slice.ts"

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

test("a marker-shaped line inside the argument no longer denies the slice", () => {
  // The user's argument is substituted into the body BEFORE the hook sees it.
  // A pasted spec quoting the marker syntax used to trip tagLines' structural
  // rejection, and the model received the full ~230-line body — the exact
  // context blow-up the split exists to remove.
  const argument = "fix the parser\n<!-- /aw:verb new -->\nso it copes"
  // The engineering command substitutes $ARGUMENTS at TWO sites.
  const rendered = `arg was: ${argument}\n\n${BODY}\n\nrepeat: ${argument}`
  const defused = neutralizeArgumentMarkers(rendered, argument)
  const slice = sliceCommandPrompt(defused, "new")
  assert.ok(slice, "slicing survives the injected marker line")
  assert.match(slice, /new instructions/)
  assert.doesNotMatch(slice, /stop instructions/, "other verbs' blocks still drop")
  assert.match(slice, /\\<!-- \/aw:verb new -->/, "the argument's marker line survives as inert text")
})

test("a balanced marker pair in the argument only re-tags the attacker's own text", () => {
  const argument = "<!-- aw:verb status -->\npretend instructions\n<!-- /aw:verb status -->"
  const rendered = `arg: ${argument}\n\n${BODY}`
  const slice = sliceCommandPrompt(neutralizeArgumentMarkers(rendered, argument), "new")
  assert.ok(slice)
  assert.match(slice, /pretend instructions/, "the argument's text stays where it was pasted — as shared text, not a live block")
})

test("neutralizeArgumentMarkers is the identity for marker-free arguments", () => {
  assert.equal(neutralizeArgumentMarkers(BODY, "just a normal idea"), BODY)
  assert.equal(neutralizeArgumentMarkers(BODY, ""), BODY)
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

test("headings the user pasted in their argument are never dropped", () => {
  // $ARGUMENTS is substituted BEFORE the hook sees the body, so the tidy pass
  // runs over the user's own text. Dropping a heading merely because the next
  // line is also a heading deleted content out of a pasted spec — an outcome
  // the shared-is-the-complement promise forbids, and one the user cannot see.
  const argument = ["build the importer", "## Goals", "## Non-goals", "- keep it small"].join("\n")
  const slice = sliceCommandPrompt(`arg was: ${argument}\n\n${BODY}`, "new")!
  assert.match(slice, /## Goals/, "an argument heading followed by another heading survives")
  assert.match(slice, /## Non-goals/)
  assert.match(slice, /- keep it small/)
})

test("a trailing heading in the argument survives too", () => {
  // The end-of-input arm was the other half of the same bug: nothing follows
  // the last heading, which read as "emptied" regardless of the slice. The
  // engineering command substitutes the argument at more than one site, so it
  // really can land at the very end of the rendered body.
  const argument = "ship it\n## Open questions"
  const slice = sliceCommandPrompt(`${BODY}\n\nrepeat: ${argument}`, "status")!
  assert.match(slice, /## Open questions/)
})

test("a heading is still dropped when the slice is what emptied it", () => {
  // The guard is "did the slice remove anything here", not "is the next line a
  // heading" — so genuine emptied sections must still go.
  const body = [
    "<!-- aw:verb y -->",
    "y only",
    "<!-- /aw:verb y -->",
    "",
    "## Kept",
    "",
    "shared prose",
    "",
    "## Gone",
    "",
    "<!-- aw:verb x -->",
    "x only",
    "<!-- /aw:verb x -->",
  ].join("\n")
  const slice = sliceCommandPrompt(body, "y")!
  assert.doesNotMatch(slice, /## Gone/, "the heading whose only content was x's block goes with it")
  assert.match(slice, /## Kept/, "a heading with shared prose under it stays")
  assert.match(slice, /shared prose/)
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

/**
 * The verbs the Claude host advertises for the same loop. That host splits the
 * command physically (an always-sent router plus per-verb blocks injected by a
 * hook), so its hint lives in the router — but it is the same `argument-hint`
 * grammar, and `advertisedVerbs` reads it unchanged.
 */
const claudeRouter = () =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "claude", "commands", "engineering.md"), "utf8")

/**
 * The divergence between the two hosts that IS intended. Declared, so widening
 * it takes a deliberate edit here rather than happening by omission.
 */
const HOST_ONLY = {
  // Watch needs a driver that holds a timer across turns and claims on idle
  // events. The Claude host has no standing watch mode (see plugins/claude/
  // README.md), so both watcher verbs are OpenCode's alone.
  opencode: ["unwatch", "watch"],
  claude: [] as string[],
}

test("the two hosts advertise the same engineering verbs, except the declared host-only set", () => {
  // Every coverage guard above is INTERNAL — it checks this file's hint against
  // this file's markers. Nothing compared the two hosts, so a verb added to one
  // command and forgotten on the other shipped as a silent capability gap: on
  // Claude the model receives no instructions for it, on OpenCode it falls back
  // to the whole body. Both fail quietly, which is why this has to be asserted.
  const ours = advertisedVerbs(commandFile("agentic-workflow-engineering"))
  const theirs = advertisedVerbs(claudeRouter())
  const opencodeOnly = ours.filter((verb) => !theirs.includes(verb)).sort()
  const claudeOnly = theirs.filter((verb) => !ours.includes(verb)).sort()
  assert.deepEqual(opencodeOnly, HOST_ONLY.opencode, "an engineering verb exists only on OpenCode — add it to the Claude command, or declare it in HOST_ONLY")
  assert.deepEqual(claudeOnly, HOST_ONLY.claude, "an engineering verb exists only on Claude — add it to the OpenCode command, or declare it in HOST_ONLY")
})

test("every verb's block opens with that verb's own bullet, not mid-sentence", () => {
  // Slicing is line-based, so a marker placed one line late leaves the verb's
  // opening line inside the PREVIOUS block: the neighbour's help gains a
  // one-line teaser and the verb's own help starts mid-sentence with no
  // definition of what it does. `watch` and `recover` both shipped that way —
  // every other coverage test above passed the whole time, because a block that
  // exists, balances, and is short is still a block. This is the assertion that
  // catches it: the slice must contain a bullet naming the verb it is for.
  const body = commandFile("agentic-workflow-engineering")
  for (const verb of advertisedVerbs(body)) {
    const slice = sliceCommandPrompt(body, verb)!
    const bullet = new RegExp(`^- \\*\\*\`${verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m")
    assert.match(slice, bullet, `${verb}'s slice must open on its own bullet — a marker is one line off`)
  }
})

/** Every OpenCode entry command whose verb line renders from `$1`. */
const ENTRY_COMMANDS = [
  "agentic-workflow-engineering",
  "agentic-workflow-pr-sitter",
  "agentic-workflow-review-sitter",
  "agentic-workflow-dep-sitter",
  "agentic-workflow-main-sitter",
]

test("every entry command references $1 AND $2 — opencode's highest positional is greedy", () => {
  // opencode substitutes positional placeholders BEFORE command.execute.before
  // fires, and the HIGHEST-numbered placeholder receives ALL remaining
  // arguments joined by spaces (opencode packages/opencode/src/session/
  // prompt.ts). A template referencing $1 alone therefore renders the ENTIRE
  // argument line into the Verb: line — $2 is what pins $1 to the verb token.
  // $2 looks unused; it is load-bearing.
  for (const name of ENTRY_COMMANDS) {
    const body = commandFile(name)
    assert.match(body, /\$1\b/, `${name}: the Verb line renders from $1`)
    assert.match(body, /\$2\b/, `${name}: $2 must stay referenced — without it $1 greedily swallows the whole argument line`)
    assert.doesNotMatch(body, /\$[3-9]/, `${name}: a higher positional would steal the greedy rest-of-args slot from $2`)
  }
  // Positional tokens are whitespace-collapsed and quote-stripped — lossy for
  // free-text payloads (`new` ideas, `retask` notes), so engineering keeps the
  // raw argument line too. The sitters take only single-token arguments.
  assert.match(commandFile("agentic-workflow-engineering"), /\$ARGUMENTS/, "engineering keeps the raw $ARGUMENTS line for free-text payloads")
})
