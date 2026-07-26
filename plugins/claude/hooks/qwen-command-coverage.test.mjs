import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { sliceForVerb, unmarkedLines, verbsIn } from "./verb-slice.mjs"

/**
 * The Qwen host's router/verbs contract — the twin of verb-slice.test.mjs, which
 * only ever reads the Claude plugin's own files.
 *
 * This file exists because of a real miss: when a verb (`abandon`) was added on
 * main, the generated verbs file picked it up automatically but the Qwen
 * router's `argument-hint` — hand-authored, like Claude's — did not, and nothing
 * failed. A verb the router advertises but the verbs file has no block for gets
 * NO instructions at all; a block for a verb the router never advertises is
 * dead weight. Neither errors at runtime, on either host.
 *
 * The verbs file itself is generated from one source for both hosts, so this
 * suite deliberately checks the pair that is NOT single-sourced: the Qwen
 * router against the Qwen rendering.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8")
const qwenRouter = () => read("plugins", "qwen", "commands", "engineering.md")
const qwenVerbs = () => read("plugins", "qwen", "verbs", "engineering.md")
const claudeRouter = () => read("plugins", "claude", "commands", "engineering.md")

/** The verb forms the router advertises, bracket-depth-aware so `[id]`/`<idea>` don't split. */
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
  return forms.map((f) => f.trim().split(/\s+/)[0]).filter(Boolean)
}

test("every verb the Qwen router advertises has a block in the Qwen verbs file", () => {
  const covered = verbsIn(qwenVerbs())
  const missing = advertisedVerbs(qwenRouter()).filter((verb) => !covered.includes(verb))
  assert.deepEqual(missing, [], "add an <!-- aw:verb … --> block, or these verbs get no instructions at all")
})

test("every block in the Qwen verbs file names a verb the Qwen router advertises", () => {
  const allowed = [...advertisedVerbs(qwenRouter()), "abort", "unknown"]
  const extra = verbsIn(qwenVerbs()).filter((verb) => !allowed.includes(verb))
  assert.deepEqual(extra, [], "a block naming an unknown verb is dead weight or a typo")
})

test("every advertised verb actually slices to something on the Qwen host", () => {
  const body = qwenVerbs()
  for (const verb of advertisedVerbs(qwenRouter())) assert.ok(sliceForVerb(body, verb), `${verb} must slice`)
})

test("the Qwen verbs file has no unmarked prose — it would be injected on every verb", () => {
  assert.deepEqual(unmarkedLines(qwenVerbs()), [], "move shared prose into the router instead")
})

// The two routers are hand-authored per host and the verbs file is shared, so
// the rosters MUST agree — a verb added to one router only would slice fine on
// that host and silently go unadvertised on the other. This is the assertion
// that would have caught the `abandon` miss.
test("both hosts' routers advertise exactly the same verbs", () => {
  assert.deepEqual(advertisedVerbs(qwenRouter()), advertisedVerbs(claudeRouter()))
})

// Qwen interpolates {{args}}; $ARGUMENTS is Claude's spelling and would reach
// the model as a literal, so the router would describe an argument it never got.
test("the Qwen router interpolates Qwen's argument placeholder, not Claude's", () => {
  const body = qwenRouter()
  assert.match(body, /\{\{args\}\}/, "the Qwen router must use {{args}}")
  assert.doesNotMatch(body, /\$ARGUMENTS/, "$ARGUMENTS is Claude's placeholder and is inert on Qwen")
})

// Qwen's `agent` tool has no model parameter. Prose telling the orchestrator to
// pass one names a parameter that does not exist and invites it to improvise.
test("no Qwen command tells the orchestrator to pass a spawn model", () => {
  for (const file of fs.readdirSync(path.join(REPO, "plugins", "qwen", "commands"))) {
    if (!file.endsWith(".md")) continue
    const body = read("plugins", "qwen", "commands", file)
    assert.doesNotMatch(body, /Task tool/, `${file} still names Claude's spawn tool`)
    assert.doesNotMatch(body, /passing the response's `model`/, `${file} still passes a spawn model`)
  }
})

test("the Qwen verbs rendering carries no Claude-only spawn prose", () => {
  const body = qwenVerbs()
  assert.doesNotMatch(body, /Task tool/, "the Qwen rendering still names Claude's spawn tool")
  assert.doesNotMatch(body, /AskUserQuestion/, "the Qwen rendering still names Claude's ask tool")
})
