import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * A check stage's stop message is not decoration — on OpenCode it is the ENTIRE
 * interface for the decision the human now owns. That host's plugin cannot
 * originate a question, and since "A stage subagent must not be able to ask" its
 * stages cannot either, so nothing else reaches the human at a stop.
 *
 * Which makes the message a contract with `waiveCheck`, and one that can drift
 * silently in either direction: a waivable stage whose message never mentions
 * `waive` leaves the human with only the two moves that re-run the thing that
 * cannot run, and an UNWAIVABLE stage whose message offers it sends them to a
 * verb that will refuse them. So both halves are pinned here, against the
 * manifests themselves rather than a hand-kept list of stage names.
 *
 * A stage is waivable exactly when `waiveCheck` would take its arm: a `check`
 * whose `onPass` is a `fire`. That predicate is duplicated here on purpose —
 * this test is the thing that notices if the manifest and the engine stop
 * agreeing.
 *
 * Scoped to BACKLOG-sourced kinds, because that is how far the waiver actually
 * reaches: `waiveCheck` is generic (it reads any manifest's arm), but both hosts'
 * entry points resolve an id in `in-progress/`, so a sitter's PR- or
 * dependency-shaped item has no waive verb behind it no matter what its arms look
 * like. Promising one in a sitter's stop message would be the same dead end this
 * file exists to catch, one kind over. A sitter that ever grows a waiver needs its
 * own entry point first, and then belongs in this scope.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WORKFLOWS = path.join(ROOT, "packages", "core", "workflows")

const manifests = () =>
  fs
    .readdirSync(WORKFLOWS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((kind) => fs.existsSync(path.join(WORKFLOWS, kind, "workflow.json")))
    .map((kind) => [kind, JSON.parse(fs.readFileSync(path.join(WORKFLOWS, kind, "workflow.json"), "utf8"))])
    // See the module doc: only a backlog kind has a waive/recover verb that can
    // resolve its items, so only its messages can promise one.
    .filter(([, m]) => m.workSource?.type === "backlog")

/** Every message a CHECK stage can stop the run with, tagged with whether a waiver could take that stage's pass arm. */
const checkStopMessages = () => {
  const out = []
  for (const [kind, m] of manifests()) {
    for (const stage of m.stages) {
      if (stage.kind !== "check") continue
      const t = m.transitions?.[stage.name] ?? {}
      const waivable = t.onPass?.kind === "fire"
      // The two ways a check stage ends a run: its onError arm, and its counted
      // onFail arm exhausting the iteration budget.
      if (t.onError?.kind === "stop") out.push({ kind, stage: stage.name, waivable, where: "onError", text: t.onError.message })
      if (t.onFail?.countIteration && t.onFail.capMessage) out.push({ kind, stage: stage.name, waivable, where: "onFail.capMessage", text: t.onFail.capMessage })
    }
  }
  return out
}

test("the manifests do declare check-stage stop messages to check", () => {
  const msgs = checkStopMessages()
  assert.ok(msgs.length >= 3, `expected engineering's verify onError + capMessage and review onError at least, got ${msgs.length}`)
  assert.ok(
    msgs.some((m) => m.kind === "engineering" && m.stage === "verify" && m.waivable),
    "engineering's verify must be waivable — it is the case the waiver exists for",
  )
  assert.ok(
    msgs.some((m) => m.kind === "engineering" && m.stage === "review" && !m.waivable),
    "engineering's review must NOT be waivable — its onPass ends the run",
  )
})

test("a waivable check stage's stop message names the waiver, since on OpenCode nothing else will", () => {
  for (const m of checkStopMessages()) {
    if (!m.waivable) continue
    assert.match(m.text, /\bwaive\b/, `${m.kind}/${m.stage} ${m.where}: a waivable stage's stop must name \`waive\` — the human has no other channel on OpenCode`)
  }
})

test("an unwaivable check stage's stop message never offers a waiver", () => {
  for (const m of checkStopMessages()) {
    if (m.waivable) continue
    // "cannot be waived" is the one legitimate mention: naming the restriction is
    // not offering the move. Anything else would send the human to a refusal.
    const offers = /\bwaive\b/.test(m.text) && !/cannot be waived/.test(m.text)
    assert.ok(!offers, `${m.kind}/${m.stage} ${m.where}: offers a waiver \`waiveCheck\` will refuse — it is the pipeline's last check`)
  }
})

test("every check-stage stop message points at a move, never at a dead end", () => {
  // The failure this guards is a stop that reports a state and stops there. Each
  // one must name at least one verb the human can actually type.
  for (const m of checkStopMessages()) {
    assert.match(m.text, /\brecover\b|\breplan\b|\bwaive\b/, `${m.kind}/${m.stage} ${m.where}: names no follow-up verb`)
  }
})

test("a stop that promises `recover` says it resumes at the stage, not at BUILD", () => {
  // The whole reported bug in one sentence: `recover` used to restart at BUILD
  // here, so the message has to state what it now does, or the human cannot tell
  // the fixed behaviour from the old one.
  for (const m of checkStopMessages()) {
    if (!/\brecover\b/.test(m.text)) continue
    assert.match(m.text, /not at BUILD/, `${m.kind}/${m.stage} ${m.where}: says recover without saying it resumes at ${m.stage}`)
  }
})
