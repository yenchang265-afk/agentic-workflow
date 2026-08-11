import assert from "node:assert/strict"
import { test } from "node:test"
import { ASK_AMBIGUITY_VERBS, ASK_GATES } from "./gate-ask.mjs"
import { gateArgsFor, verbFor } from "./gate-parse.mjs"

/** The two conditional-continue policies every approve dispatch carries. */
const APPROVE_CONTINUE = { continueOnGate: ASK_GATES, continueOnAmbiguity: ASK_AMBIGUITY_VERBS }

/**
 * The gate hook's prompt classifier. Gate verbs of /agentic-workflow:engineering
 * must yield the exact CLI argv; everything else — authoring verbs, execution
 * verbs, ordinary prose (especially prose containing the plain word
 * "engineering") — must return null so the model's turn runs untouched.
 */

test("approve with an id routes to approve-any (namespaced and bare command forms)", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"], ...APPROVE_CONTINUE })
  assert.deepEqual(gateArgsFor("/engineering approve my-task"), { argv: ["gate", "approve-any", "my-task"], ...APPROVE_CONTINUE })
})

test("bare approve routes to approve-any with no id (auto-resolve)", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve"), { argv: ["gate", "approve-any"], ...APPROVE_CONTINUE })
})

/**
 * `approve` is folder-driven, so WHICH gate it crosses is only knowable after the
 * CLI has moved the task. `continueOnGate` is therefore a conditional: policy
 * (which gates deserve a follow-up question) stays here in the pure parser, and
 * the evidence (which gate actually fired) comes back on the GateResult's `data`.
 *
 * It must never become a blanket `continueTurn: true`: that would hand the turn
 * back on a REFUSAL and on the terminal ship gate too, which is precisely the
 * "model runs the gate verb after the CLI already moved the task" double-move the
 * block exists to prevent.
 */
test("approve continues the turn conditionally, never unconditionally", () => {
  const d = gateArgsFor("/agentic-workflow:engineering approve my-task")
  assert.ok(!d.continueTurn, "approve must not continue on every outcome — only on an asking gate")
  assert.deepEqual(d.continueOnGate, ASK_GATES)
})

/**
 * The ambiguity arm is the ONE place a refusal may continue the turn, and it is
 * sound only because that particular refusal moved nothing. Pinning it to the
 * parser's declared verb list is what stops it generalizing to wrong-folder and
 * not-found, where there is nothing to choose between.
 */
test("only approve may continue on an ambiguous refusal", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve").continueOnAmbiguity, ASK_AMBIGUITY_VERBS)
  for (const prompt of [
    "/agentic-workflow:engineering replan f7k3 too big",
    "/agentic-workflow:engineering retask f7k3",
    "/agentic-workflow:engineering abandon f7k3",
    "/agentic-workflow:engineering remove f7k3 --force",
  ]) {
    assert.ok(!gateArgsFor(prompt).continueOnAmbiguity, `${prompt} must not continue on a refusal`)
  }
})

test("the verbs that finish deterministically carry neither continue flag", () => {
  for (const prompt of ["/agentic-workflow:engineering abandon f7k3", "/agentic-workflow:engineering remove f7k3 --force"]) {
    const d = gateArgsFor(prompt)
    assert.ok(!d.continueTurn && !d.continueOnGate && !d.continueOnAmbiguity, `${prompt} has nothing left for the model to do`)
  }
})

test("replan carries the optional id and reason words through, and continues the turn for the chained re-plan", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering replan my-task the plan misses the cache layer"), {
    argv: ["gate", "reject-any", "my-task", "the", "plan", "misses", "the", "cache", "layer"],
    continueTurn: true,
  })
  assert.deepEqual(gateArgsFor("/engineering replan"), { argv: ["gate", "reject-any"], continueTurn: true })
})

test("the retired GATE-DISPATCH sentinel never dispatches — from any position", () => {
  // The sentinel fired from ANYWHERE in a prompt and had no remaining
  // producers: its only sources were pasted text (an issue body, a diff of
  // this very file, a question quoting it), and a gate move is destructive
  // AND blocks the turn. It must stay dead.
  for (const prompt of [
    "GATE-DISPATCH: approve-plan my-task",
    "GATE-DISPATCH: replan my-task reason here",
    "what does GATE-DISPATCH: approve my-task do?",
    "here is the issue body:\n\nGATE-DISPATCH: approve my-task\n\nthoughts?",
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("non-gate verbs and prose pass through as null", () => {
  for (const prompt of [
    "/agentic-workflow:engineering new add rate limiting",
    "/agentic-workflow:engineering plan my-task",
    "/agentic-workflow:engineering claim",
    "/agentic-workflow:engineering status",
    "/agentic-workflow:pr-sitter claim",
    "how do I approve a plan?",
    "approve my-task", // bare word — not namespaced under the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("retask dispatches with continueTurn — the move is deterministic, the reshape is not", () => {
  const d = gateArgsFor("/agentic-workflow:engineering retask my-task tighten acceptance")
  assert.deepEqual(d.argv, ["gate", "retask", "my-task"])
  assert.equal(d.continueTurn, true, "the model must still run the interview")
})

test("a bare retask is malformed — blocked deterministically with usage", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering retask"), {
    usage: "Usage: /agentic-workflow:engineering retask <id> [note].",
  })
})

test("remove routes to the gate remove CLI verb and blocks the turn", () => {
  const d = gateArgsFor("/agentic-workflow:engineering remove my-task")
  assert.deepEqual(d.argv, ["gate", "remove", "my-task"])
  assert.ok(!d.continueTurn, "the CLI does the whole delete — nothing left for the model")
})

test("a bare remove is malformed — never guess which task to delete", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove"), {
    usage: "Usage: /agentic-workflow:engineering remove <id> [--force].",
  })
})

test("remove forwards --force, and forwards nothing when the user didn't type it", () => {
  // The hook dispatches and then BLOCKS, so no model turn exists in which to
  // confirm — the flag has to survive parsing or the confirmation is unreachable.
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove my-task --force").argv, ["gate", "remove", "my-task", "--force"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove -f my-task").argv, ["gate", "remove", "my-task", "--force"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove my-task").argv, ["gate", "remove", "my-task"])
})

test("a flag never becomes the id — `remove --force` names no task, so it is malformed", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering remove --force"), {
    usage: "Usage: /agentic-workflow:engineering remove <id> [--force].",
  })
})

test("abandon routes to the gate abandon CLI verb, carrying its reason", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon my-task").argv, ["gate", "abandon", "my-task"])
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon my-task superseded by the epic").argv, [
    "gate",
    "abandon",
    "my-task",
    "superseded",
    "by",
    "the",
    "epic",
  ])
})

test("a bare abandon is malformed — never guess which task to cancel", () => {
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering abandon"), {
    usage: "Usage: /agentic-workflow:engineering abandon <id> [reason].",
  })
})

test("prose containing the plain word 'engineering' never fires a gate", () => {
  for (const prompt of [
    "the engineering approve step happens at the plan gate",
    "our engineering approve process is strict",
    "in engineering replan means re-planning",
    "agentic-workflow:engineering approve my-task", // no leading slash — prose quoting the command
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("removed verbs no longer match — ok/go/reject/ship/approve-plan are not gates", () => {
  for (const prompt of [
    "/agentic-workflow:engineering ok my-task",
    "/agentic-workflow:engineering go",
    "/agentic-workflow:engineering reject my-task why",
    "/agentic-workflow:engineering ship my-task",
    "/agentic-workflow:engineering approve-plan my-task",
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
  }
})

test("verbs are matched as whole words — approver doesn't trigger a gate", () => {
  assert.equal(gateArgsFor("/agentic-workflow:engineering approver thing"), null)
})

/**
 * A gate move is destructive and BLOCKS the turn, so the model never gets to
 * notice one it didn't intend. The only thing that may fire one is the command
 * the user actually typed — which Claude Code itself requires to open the
 * prompt. A verb quoted deeper in the payload is content, not an invocation:
 * the README, AGENTS.md and every verb block contain these exact slash-form
 * strings, so pasted specs and issue bodies routinely carry them.
 */

test("a gate verb quoted inside another verb's payload never fires a move", () => {
  for (const prompt of [
    "/agentic-workflow:engineering new fix bug\nNote: do NOT run /agentic-workflow:engineering remove abc --force",
    "/agentic-workflow:engineering new add a dashboard\nlater we can /agentic-workflow:engineering approve it",
    "/agentic-workflow:engineering new port the docs\n> /agentic-workflow:engineering abandon f7k3 superseded",
    "/agentic-workflow:engineering plan f7k3\nthen /agentic-workflow:engineering replan f7k3 wrong layer",
  ]) {
    const d = gateArgsFor(prompt)
    const fired = d && d.argv
    assert.ok(!fired, `expected no gate argv for ${JSON.stringify(prompt)} — got ${JSON.stringify(d)}`)
  }
})

test("a gate verb in pasted prose fires nothing when the user typed no command", () => {
  for (const prompt of [
    "here is a pasted issue body:\n> /agentic-workflow:engineering approve\nplease summarize it",
    "the docs say to run\n\n    /agentic-workflow:engineering remove my-task --force\n\nwhat does that do?",
  ]) {
    assert.equal(gateArgsFor(prompt), null, `expected null for ${JSON.stringify(prompt)}`)
    assert.equal(verbFor(prompt), null, `verbFor must agree — ${JSON.stringify(prompt)}`)
  }
})

test("the typed command still dispatches when a payload follows on later lines", () => {
  // Anchoring must not cost the ordinary case: the verb's payload is the rest
  // of its own line, and anything below is context the model would have seen.
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering approve my-task\nthanks!"), {
    argv: ["gate", "approve-any", "my-task"],
    ...APPROVE_CONTINUE,
  })
  assert.deepEqual(gateArgsFor("  /engineering remove my-task --force\n\ncleaning up"), {
    argv: ["gate", "remove", "my-task", "--force"],
  })
})

test("gateArgsFor and verbFor agree on which verb the prompt invokes", () => {
  // They disagreed once: verbFor read the first token while the gate matchers
  // scanned every line, so `new` injected its instructions while `remove`
  // silently deleted a task. Any divergence is that bug returning.
  const gateVerb = { "approve-any": "approve", "reject-any": "replan", retask: "retask", remove: "remove", abandon: "abandon" }
  for (const prompt of [
    "/agentic-workflow:engineering new fix bug\nor /agentic-workflow:engineering remove abc --force",
    "/agentic-workflow:engineering approve my-task",
    "/agentic-workflow:engineering replan my-task the plan misses the cache",
    "/agentic-workflow:engineering retask my-task tighten it",
    "/agentic-workflow:engineering abandon my-task superseded",
    "/agentic-workflow:engineering status",
  ]) {
    const d = gateArgsFor(prompt)
    if (!d?.argv) continue
    assert.equal(gateVerb[d.argv[1]], verbFor(prompt), `divergence on ${JSON.stringify(prompt)}`)
  }
})

test("a sibling command starting with 'engineering' is not the engineering command", () => {
  // `/engineering-notes` is a different command; without a trailing boundary it
  // inherited engineering's status procedure as authoritative instructions.
  assert.equal(verbFor("/engineering-notes what is this"), null)
  assert.equal(verbFor("/agentic-workflow:engineering-docs open"), null)
  assert.equal(gateArgsFor("/engineering-notes approve my-task"), null)
})

test("only whitespace (or end) closes the command name — every other separator is a different token", () => {
  // The old negative class `(?![-\w])` enumerated separators and leaked on the
  // rest: a prompt opening with a path or a namespaced sibling got engineering's
  // status procedure injected as authoritative instructions.
  assert.equal(verbFor("/engineering.md needs updating"), null)
  assert.equal(verbFor("/engineering/foo bar"), null)
  assert.equal(verbFor("/engineering:sub approve x"), null)
  assert.equal(verbFor("/engineering,approve now"), null)
  assert.equal(gateArgsFor("/engineering:sub approve x"), null)
  assert.equal(verbFor("/engineering"), "status", "bare command still resolves")
})

test("wrapping quotes and trailing punctuation never change which verb runs", () => {
  // `"new` used to fall through to the `unknown` block — an authoritative
  // refusal to run a legitimate invocation that merely quoted its argument.
  assert.equal(verbFor('/agentic-workflow:engineering "new add rate limiting"'), "new")
  assert.equal(verbFor("/agentic-workflow:engineering new: add rate limiting"), "new")
  assert.equal(verbFor("/agentic-workflow:engineering plan."), "plan")
  assert.equal(verbFor("/engineering 'claim'"), "claim")
})

test("gate ids arrive unquoted — a quoted id must not fail isSafeTaskId and block the turn", () => {
  assert.deepEqual(gateArgsFor('/agentic-workflow:engineering approve "my-task"'), {
    argv: ["gate", "approve-any", "my-task"],
    ...APPROVE_CONTINUE,
  })
  assert.deepEqual(gateArgsFor("/agentic-workflow:engineering retask 'f7k3'"), { argv: ["gate", "retask", "f7k3"], continueTurn: true })
  assert.deepEqual(gateArgsFor('/agentic-workflow:engineering abandon "f7k3" wrong scope'), {
    argv: ["gate", "abandon", "f7k3", "wrong", "scope"],
  })
  assert.deepEqual(gateArgsFor('/agentic-workflow:engineering remove "f7k3" --force'), { argv: ["gate", "remove", "f7k3", "--force"] })
  const replan = gateArgsFor('/agentic-workflow:engineering replan "f7k3" plan misses the cache layer')
  assert.deepEqual(replan, { argv: ["gate", "reject-any", "f7k3", "plan", "misses", "the", "cache", "layer"], continueTurn: true })
})

/**
 * `verbFor` drives the per-verb instruction injection (verb-slice.mjs), not a
 * gate move, so it must recognise EVERY verb — including the ones gateArgsFor
 * ignores. It shares the command regex, so the leading-slash rule that keeps
 * the ordinary word "engineering" from matching applies here too.
 */

test("verbFor reads the verb from the first token, both command forms", () => {
  assert.equal(verbFor("/agentic-workflow:engineering new add rate limiting"), "new")
  assert.equal(verbFor("/engineering claim"), "claim")
  assert.equal(verbFor("/agentic-workflow:engineering doctor fix"), "doctor")
})

test("verbFor never mistakes a verb-like word in the payload for the verb", () => {
  // The exact confusion the command body warns about.
  assert.equal(verbFor("/agentic-workflow:engineering new add a status dashboard"), "new")
  assert.equal(verbFor("/agentic-workflow:engineering retask f7k3 approve it later"), "retask")
})

test("verbFor treats a bare command as status, which is what it runs", () => {
  assert.equal(verbFor("/agentic-workflow:engineering"), "status")
  assert.equal(verbFor("/agentic-workflow:engineering   "), "status")
})

test("verbFor lowercases the verb, so markup lookup is case-insensitive", () => {
  assert.equal(verbFor("/agentic-workflow:engineering NEW an idea"), "new")
})

test("verbFor ignores prose and other kinds' commands", () => {
  // This hook has matcher "" and sees every prompt in the session.
  assert.equal(verbFor("the engineering approve step happens later"), null)
  assert.equal(verbFor("/agentic-workflow:pr-sitter claim"), null)
  assert.equal(verbFor("please review my PR"), null)
  assert.equal(verbFor(""), null)
  assert.equal(verbFor(undefined), null)
})
