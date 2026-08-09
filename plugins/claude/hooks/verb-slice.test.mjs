import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { sliceForVerb, unmarkedLines, verbContext, verbsIn } from "./verb-slice.mjs"

/**
 * On this host the command body cannot be rewritten, so the split is physical:
 * commands/engineering.md is a router that is always sent, verbs/engineering.md
 * holds every verb's procedure and is never sent whole. The content contracts
 * below are the only thing that would notice the two drifting apart — nothing
 * else reads either file.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8")
const router = () => read("commands", "engineering.md")
const verbs = () => read("verbs", "engineering.md")

const BODY = [
  "<!-- aw:verb new -->",
  "interview the user",
  "<!-- /aw:verb new -->",
  "<!-- aw:verb stop|abort -->",
  "abort the loop",
  "<!-- /aw:verb stop|abort -->",
].join("\n")

test("a slice is the invoked verb's block, markers stripped", () => {
  assert.equal(sliceForVerb(BODY, "new"), "interview the user")
})

test("another verb's block never leaks into the slice", () => {
  assert.doesNotMatch(sliceForVerb(BODY, "new"), /abort the loop/)
})

test("one block can serve a verb and its alias", () => {
  assert.equal(sliceForVerb(BODY, "stop"), sliceForVerb(BODY, "abort"))
})

test("the verb is matched case-insensitively and trimmed", () => {
  assert.equal(sliceForVerb(BODY, "  NEW "), "interview the user")
})

test("an absent verb slices to nothing — mapping bare to status is verbFor's job, not this module's", () => {
  // Defaulting here would swallow verbFor's null (a prompt that is not the
  // engineering command) and inject engineering's status procedure into every
  // unrelated prompt in the session.
  const body = `${BODY}\n<!-- aw:verb status -->\nreport the roll-up\n<!-- /aw:verb status -->`
  for (const absent of ["", "   ", null, undefined]) {
    assert.equal(sliceForVerb(body, absent), null, JSON.stringify(absent))
    assert.equal(verbContext(ROOT, absent), null, JSON.stringify(absent))
  }
})

test("a verb with no block slices to nothing — the fallback is verbContext's job", () => {
  assert.equal(sliceForVerb(BODY, "bogus"), null)
})

test("two blocks of one verb stay separated by a blank line", () => {
  // The source separates blocks with unmarked blank lines, which the slicer
  // drops — a plain join glued the last bullet of one block onto the first
  // directive of the next, and markdown lazy continuation swallowed it.
  const body = [
    "<!-- aw:verb new -->",
    "- a bullet about tracker pairing",
    "<!-- /aw:verb new -->",
    "",
    "<!-- aw:verb new|plan -->",
    "Read the protocol skill now.",
    "<!-- /aw:verb new|plan -->",
  ].join("\n")
  assert.equal(sliceForVerb(body, "new"), "- a bullet about tracker pairing\n\nRead the protocol skill now.")
  assert.equal(sliceForVerb(body, "plan"), "Read the protocol skill now.", "a single-block slice carries no stray separator")
})

test("no shipped verb's slice glues two blocks onto one line", () => {
  const body = verbs()
  // Every line that opens a block in the source must, in any slice containing
  // it mid-slice, be preceded by a blank line — not by another block's tail.
  const opensBlock = new Set()
  let prevWasOpen = false
  for (const line of body.split("\n")) {
    if (/^<!--\s*aw:verb /.test(line.trim())) {
      prevWasOpen = true
      continue
    }
    if (prevWasOpen && line.trim().length > 0) opensBlock.add(line)
    prevWasOpen = false
  }
  for (const verb of verbsIn(body)) {
    const lines = sliceForVerb(body, verb).split("\n")
    lines.forEach((line, i) => {
      if (i === 0 || !opensBlock.has(line)) return
      assert.equal(lines[i - 1].trim(), "", `verb "${verb}": block-opening line ${JSON.stringify(line)} must follow a blank line`)
    })
  }
})

test("an unrecognized verb gets the `unknown` block, not a false 'the hooks are broken' report", () => {
  // The router tells the model that a missing VERB INSTRUCTIONS block means the
  // hooks are not running — reinstall and restart. So injecting nothing for a
  // typo (`statuss`) or a free-text goal produced a confident, wrong diagnosis.
  // The `unknown` block was written for this case and was unreachable: only a
  // user literally typing the verb `unknown` ever selected it.
  const context = verbContext(ROOT, "statuss")
  assert.ok(context, "an unrecognized verb must still receive instructions")
  assert.match(context, /do not run it/i, "and they must be the usage block, not another verb's procedure")

  // A prompt that is not the engineering command at all still injects nothing —
  // verbFor returns null there, and that must not become a usage dump.
  assert.equal(verbContext(ROOT, null), null)
})

test("broken markup injects nothing rather than half a procedure", () => {
  const cases = {
    unclosed: "<!-- aw:verb new -->\nx",
    "stray close": "x\n<!-- /aw:verb new -->",
    nested: "<!-- aw:verb new -->\n<!-- aw:verb old -->\nx\n<!-- /aw:verb old -->\n<!-- /aw:verb new -->",
    "mismatched close": "<!-- aw:verb new -->\nx\n<!-- /aw:verb old -->",
  }
  for (const [name, body] of Object.entries(cases)) {
    assert.equal(sliceForVerb(body, "new"), null, name)
    assert.deepEqual(verbsIn(body), [], `${name}: broken markup covers no verb`)
  }
})

test("a marker inside a line of prose is inert, because markers must own their line", () => {
  const body = BODY.replace("interview the user", "interview <!-- /aw:verb new --> the user")
  assert.equal(sliceForVerb(body, "new"), "interview <!-- /aw:verb new --> the user")
})

test("the injected context labels itself as authoritative over the router", () => {
  const context = verbContext(ROOT, "new")
  assert.ok(context, "the shipped verb file must slice for new")
  assert.match(context, /VERB INSTRUCTIONS — \/agentic-workflow:engineering new/)
  assert.match(context, /only the router/, "the model must know which of the two to follow")
  assert.match(context, /interview/i, "the new procedure must be in there")
})

test("a missing verb file injects nothing — a partial install behaves as before this hook", () => {
  assert.equal(verbContext(path.join(ROOT, "does-not-exist"), "new"), null)
})

/**
 * Coverage. A verb losing its block is silent: the hook injects nothing and the
 * model falls back to the router's "hooks are not running" rule, which would be
 * a confusing lie. So assert the markup tracks the router's `argument-hint`.
 */
const advertisedVerbs = (body) => {
  const hint = /^argument-hint:\s*(.+)$/m.exec(body)
  assert.ok(hint, "the router must declare an argument-hint")
  const forms = []
  let depth = 0
  let current = ""
  for (const ch of hint[1]) {
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
  return [...new Set(forms.map((form) => form.trim().split(/[\s<[]/)[0].trim()).filter(Boolean))]
}

test("every verb the router advertises has a block in the verbs file", () => {
  const covered = verbsIn(verbs())
  const missing = advertisedVerbs(router()).filter((verb) => !covered.includes(verb))
  assert.deepEqual(missing, [], "add an <!-- aw:verb … --> block, or these verbs get no instructions at all")
})

test("every block in the verbs file names a verb the router advertises", () => {
  // `abort` is an alias of `stop`; `unknown` is the reserved catch-all block.
  const allowed = [...advertisedVerbs(router()), "abort", "unknown"]
  const extra = verbsIn(verbs()).filter((verb) => !allowed.includes(verb))
  assert.deepEqual(extra, [], "a block naming an unknown verb is dead weight or a typo")
})

test("every advertised verb actually slices to something", () => {
  const body = verbs()
  for (const verb of advertisedVerbs(router())) assert.ok(sliceForVerb(body, verb), `${verb} must slice`)
})

test("the verbs file has no unmarked prose — it would be injected on every verb", () => {
  assert.deepEqual(unmarkedLines(verbs()), [], "move shared prose into the router instead")
})

test("every verb's block opens with that verb's own bullet, not mid-sentence", () => {
  // The opencode command shipped two blocks whose marker sat one line late, so
  // the verb's opening bullet stayed in the PREVIOUS block and its own help
  // began mid-sentence. This file is correctly aligned today; pin it, because
  // every other coverage test here passes either way.
  const body = verbs()
  for (const verb of advertisedVerbs(router())) {
    const slice = sliceForVerb(body, verb)
    const bullet = new RegExp(`^- \\*\\*\`${verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m")
    assert.match(slice, bullet, `${verb}'s block must open on its own bullet — a marker is one line off`)
  }
})

/**
 * `approve` is the one gate verb that can hand the turn back: after a TASK gate
 * the hook appends a follow-up asking whether to plan the task now, and the yes
 * branch runs a PLAN pass. A slice only ever contains its own blocks, so the
 * PLAN procedure has to be reachable from `approve` — hence the shared
 * `approve|plan` marker. Retag it back to `plan` alone and nothing errors: the
 * follow-up simply arrives next to a verb block that never says how to plan.
 */
test("the approve slice carries the PLAN procedure its follow-up sends the model to", () => {
  const slice = sliceForVerb(verbs(), "approve")
  assert.match(slice, /workflow_start/, "the yes branch's entry point")
  assert.match(slice, /workflow-plan-author/, "the planner it spawns")
  assert.match(slice, /workflow_advance/, "what parks the plan for the gate")
  assert.match(slice, /workflow-orchestration/, "the gate protocol pointer the shared block carries")
})

test("the router carries no verb procedure, so nothing is said twice", () => {
  const body = router()
  assert.doesNotMatch(body, /aw:verb/, "the router is never sliced")
  // The procedures name MCP tools and subagents; the router must not.
  assert.doesNotMatch(body, /mcp__agentic-workflow__/, "tool calls belong in the verb blocks")
  assert.doesNotMatch(body, /workflow-plan-author/, "subagent names belong in the verb blocks")
})

test("the router keeps the instructions for the hook having failed open", () => {
  // Anything covering "the hook did not run" cannot live in a file the hook injects.
  assert.match(router(), /Verify before you report a gate/)
  assert.doesNotMatch(verbs(), /Verify before you report a gate/)
})

test("the router keeps the standing prohibitions, which apply to every verb", () => {
  assert.match(router(), /Never touch `docs\/tasks\/\*\*` directly/)
  assert.match(router(), /Do not invent your own control flow/)
})

test("the router tells the model what to do when no block arrives", () => {
  assert.match(router(), /no VERB INSTRUCTIONS block reached you/)
  assert.match(router(), /install\.sh/, "it must name the fix")
})

test("the router is a fraction of the body it replaced", () => {
  // This ceiling is the whole per-verb context budget on this host, and it is
  // why the router earns its own size test while OpenCode's shared prose does
  // not. A `UserPromptSubmit` hook can only prepend, never rewrite, so the
  // router is sent for EVERY verb — including the ones the MCP server handles
  // end to end, whose own block is two or three lines. OpenCode gets the mirror
  // case for free: it overrides the rendered body in `command.execute.before`,
  // so prose those verbs never read costs nothing there. Neither host can adopt
  // the other's trade; keeping the router small is this host's only lever.
  assert.ok(router().split("\n").length < 90, `router is ${router().split("\n").length} lines`)
})

// `agentModels` prose used to live here: this hook interpolated a sentence
// asking the model to set the spawn tool's `model`, and `isAdhocPlan` existed
// only to find the one command that had no MCP response to carry one. Both are
// gone — the PreToolUse stamp binds the model from `subagent_type` instead, so
// there is no prompt to sniff and no sentence to inject. The behaviour those
// cases guarded now lives in ../spawn-model-stamp.test.mjs, which asserts the
// spawn CALL comes out carrying the configured model rather than asserting that
// some prose asked for it.
