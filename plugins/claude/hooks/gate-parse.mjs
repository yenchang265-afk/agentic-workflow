/**
 * Pure prompt→gate-argv parsing for the UserPromptSubmit gate hook
 * (gate-command.mjs). Split out so it can be unit-tested without running the
 * hook's stdin/spawn machinery.
 *
 * The gate verbs live under the engineering command, typed as
 * `/agentic-workflow:engineering` (or the bare `/engineering` disambiguation
 * Claude Code offers for plugin commands):
 *   approve [id]           → gate approve-any [id]   (unified folder-driven gate)
 *   replan [id] [reason]   → gate reject-any [id] [reason...]  (hybrid: the model then chains the re-plan)
 *   abandon <id> [reason]  → gate abandon <id> …     (→ abandoned/; id required)
 *   remove <id> [--force]  → gate remove <id> …      (hard-delete; id required)
 *
 * Unlike the old `agent-loop` prefix, `engineering` is an ordinary English
 * word — so the command match REQUIRES the leading slash form. Prose like
 * "the engineering approve step" must never fire a gate move.
 *
 * The slash alone is not enough, because the slash form is exactly what
 * documentation quotes: the README, AGENTS.md and every verb block contain
 * these strings verbatim, so a pasted spec or issue body routinely carries
 * `/agentic-workflow:engineering remove <id> --force` as prose. A gate move is
 * destructive AND blocks the turn, so a wrong one is never reported to anyone.
 * Hence the second rule: the command must OPEN the prompt (modulo leading
 * whitespace), which is also Claude Code's own rule for recognising a slash
 * command. A verb quoted further in is payload, not an invocation.
 *
 * The verb's own arguments are therefore the rest of ITS line — `(.*)` with no
 * `$` and no `m`, since `.` already stops at the newline. Ending the pattern at
 * `$` instead would refuse to dispatch a perfectly ordinary
 * `approve my-task\nthanks!`, and adding `m` back is the bug above.
 */
// The `GATE-DISPATCH:` sentinel that used to live here — a form that fired
// from ANYWHERE in the prompt — is gone: no command template emits it any
// more, so its only remaining producers were pasted text (an issue body, a
// diff of this file, a question about it), and a gate move is destructive AND
// blocks the turn. Never reintroduce a position-independent trigger.

// One source of truth for which gates ask a follow-up: the parser declares them
// and gate-ask.mjs writes them. Splitting the two lists is how a gate ends up
// continuing the turn with nothing to say — the hook would hand back a turn whose
// only instruction is the outcome message.
import { ASK_AMBIGUITY_VERBS, ASK_GATES } from "./gate-ask.mjs"

// The gate verbs of /agentic-workflow:engineering — subcommands, NOT top-level
// words (so they never collide with a reserved `/approve`). The id is optional
// on approve/replan: a bare `approve` auto-resolves the single awaiting task
// (loop gates first, a lone draft as fallback — the CLI's approve-any owns that
// priority).
//
// `(?=\\s|$)` closes the command name so a sibling command cannot inherit
// engineering's verbs or its instructions: without it `/engineering-notes` read
// as engineering plus the verb `-notes`. A positive whitespace-or-end lookahead,
// not a negative character class: the old `(?![-\\w])` leaked on every
// separator it forgot to enumerate (`/engineering.md`, `/engineering:sub`,
// `/engineering/foo` all matched and injected the status procedure into
// unrelated prompts).
const CMD = "\\/(?:agentic-workflow:)?engineering(?=\\s|$)"
// `^\\s*` — the command opens the prompt; see the header for why anything later
// in the prompt is content rather than an invocation.
const AT_START = "^\\s*"
const APPROVE = new RegExp(`${AT_START}${CMD}\\s+approve(?!-)\\b[ \\t]*(.*)`, "i")
// replan is the second HYBRID verb (see retask below): the rejection move is
// deterministic, but the point of the gate is a REVISED plan — so on success
// the turn continues and the model chains one PLAN pass (workflow_start →
// plan author → advance; the verb block carries the procedure).
const REPLAN = new RegExp(`${AT_START}${CMD}\\s+replan\\b[ \\t]*(.*)`, "i")
// retask is the one HYBRID verb: its move is deterministic (queued/ → draft/, or
// a refusal) but the reshape that follows is an interview only the model can
// run. So it dispatches like a gate verb and then, on success, hands the turn
// back instead of blocking it — see `continueTurn` below.
const RETASK = new RegExp(`${AT_START}${CMD}\\s+retask\\b[ \\t]*(.*)`, "i")
// remove hard-deletes a task. Fully deterministic like approve (nothing for the
// model to do after), so it BLOCKS the turn — but it always requires an explicit
// id: there is no folder-driven "remove the awaiting one" (too easy to delete
// the wrong task), so a bare `remove` passes through for the model to report.
const REMOVE = new RegExp(`${AT_START}${CMD}\\s+remove\\b[ \\t]*(.*)`, "i")
// abandon MOVES a task to abandoned/ rather than deleting it — the reversible
// cancellation. Deterministic like remove, so it blocks the turn, and it takes
// the same explicit id for the same reason.
const ABANDON = new RegExp(`${AT_START}${CMD}\\s+abandon\\b[ \\t]*(.*)`, "i")

// Any engineering verb, for the per-verb instruction injection (verb-slice.mjs)
// rather than for a gate move. Shares CMD and AT_START so the two never
// disagree about which verb a prompt invokes — they did once, and `new` then
// injected its instructions while `remove` deleted a task in the same turn.
const ANY_VERB = new RegExp(`${AT_START}${CMD}(\\s+\\S*)?`, "i")

// The ad-hoc `/agentic-workflow:plan` command used to be matched here purely to
// inject an `agentModels` sentence for its out-of-loop `workflow-plan` spawn.
// The PreToolUse stamp binds that spawn from `subagent_type` instead, so no
// prompt sniffing is needed — one rule now covers `/plan`, `new`, `retask` and
// any nested spawn, and this matcher had no other caller.

/**
 * The engineering verb a prompt invokes, or null when the prompt is not the
 * engineering command at all.
 *
 * Mirrors the command body's own rule — the verb is the FIRST whitespace-
 * delimited token and everything after it is that verb's payload, so
 * `new add a status dashboard` is `new`, never `status`. A bare command is
 * `status`, which is what it runs.
 */
export const verbFor = (prompt) => {
  const match = String(prompt ?? "").match(ANY_VERB)
  if (!match) return null
  // Strip wrapping quotes and trailing punctuation: `"new`, `new:`, `plan.`
  // are all the verb the user typed. Left raw, they fell through to the
  // `unknown` block, which authoritatively refuses to run — a wrong answer
  // to a legitimate invocation that merely quoted its arguments.
  const raw = (match[1] || "").trim().toLowerCase()
  return raw.replace(/^["'`]+/, "").replace(/["'`.,:;!?]+$/, "") || "status"
}

/** A token with wrapping quotes stripped — `"my-task"` names the id `my-task`. */
const unquote = (word) => word.replace(/^["'`]+/, "").replace(/["'`]+$/, "")

/**
 * Build the `gate` CLI argv from the prompt, or null when it is not a gate
 * command. Every form must OPEN the prompt — see the header.
 *
 * `continueTurn` marks a dispatch whose success must NOT block the model: the
 * CLI did the deterministic part, and the model still has work to do.
 * `continueOnGate` is its conditional form, for a verb whose success only
 * SOMETIMES leaves work: it lists the `data.gate` values that hand the turn
 * back, and the CLI's result decides which one actually fired.
 * `continueOnAmbiguity` is the same idea one step further: it lists the CLI verbs
 * whose id-less REFUSAL may hand the turn back, so the model can ask which task
 * was meant. Sound only because that refusal moved nothing — see gate-command.mjs.
 * `usage` marks an id-less form of a verb that requires one: deterministic
 * refusal — the hook blocks the turn with that message, no spawn, no model.
 */
export const gateArgsFor = (prompt) => {
  const approve = prompt.match(APPROVE)
  if (approve) {
    // approve takes an optional id (first BARE token) and optional publish flags.
    // Ids are unquoted everywhere below: `approve "my-task"` names my-task, and
    // the raw quoted form failed `isSafeTaskId` in the CLI — which BLOCKED the
    // turn with a refusal that never hinted quoting was the problem.
    const words = (approve[1] || "").trim().split(/\s+/).filter(Boolean)
    const id = unquote(words.find((w) => !w.startsWith("-")) || "")
    // Options are forwarded verbatim — every dash-word, not only the three this
    // hook could recognize. The CLI owns the flag vocabulary (`parseGateOptions`
    // in core), so a typo like `--localy` earns a refusal there instead of being
    // dropped here and shipping under the configured default: a ship that
    // publishes MORE than the human asked for cannot be taken back.
    //
    // Like `--force` on remove, these must be parsed on the hook path at all:
    // this hook dispatches and then blocks, so no model turn exists to ask in.
    const opts = words.filter((w) => w.startsWith("-"))
    // approve is folder-driven: which of the three gates it crosses is only
    // knowable once the CLI has moved the task, so the continue decision cannot
    // be made here. Declaring the ASKING gates instead keeps the policy in the
    // pure parser while the CLI's `data.gate` supplies the evidence. A blanket
    // `continueTurn: true` would be wrong — it hands the turn back on refusals
    // and on the terminal ship gate, where there is nothing left to ask.
    return { argv: ["gate", "approve-any", ...(id ? [id] : []), ...opts], continueOnGate: ASK_GATES, continueOnAmbiguity: ASK_AMBIGUITY_VERBS }
  }
  const replan = prompt.match(REPLAN)
  if (replan) {
    const words = (replan[1] || "").trim().split(/\s+/).filter(Boolean)
    if (words.length) words[0] = unquote(words[0]) // the id; later words are the reason, kept verbatim
    return { argv: ["gate", "reject-any", ...words], continueTurn: true }
  }
  const retask = prompt.match(RETASK)
  if (retask) {
    // retask always names its target; a bare one is malformed — refused
    // deterministically with usage rather than guessing which task to
    // un-approve or spending a model turn to say so.
    //
    // The trailing words are the `[note]` and MUST be forwarded, exactly as
    // `abandon`/`replan` forward theirs: `runGate` joins them into `reason`, and
    // core writes ` — ${reason}` onto the audit note. Dropping them made the
    // shipped verb prose ("why the goal was wrong survives in the task file, not
    // just in this turn's context") false on the hook path — i.e. on every typed
    // command, since the hook is what a typed retask dispatches through.
    const words = (retask[1] || "").trim().split(/\s+/).filter(Boolean)
    const id = unquote(words[0] || "")
    if (!id) return { usage: "Usage: /agentic-workflow:engineering retask <id> [note]." }
    return { argv: ["gate", "retask", id, ...words.slice(1)], continueTurn: true }
  }
  const abandon = prompt.match(ABANDON)
  if (abandon) {
    const words = (abandon[1] || "").trim().split(/\s+/).filter(Boolean)
    const id = unquote(words[0] || "")
    if (!id) return { usage: "Usage: /agentic-workflow:engineering abandon <id> [reason]." }
    return { argv: ["gate", "abandon", id, ...words.slice(1)] }
  }
  const remove = prompt.match(REMOVE)
  if (remove) {
    // remove always names its target; a bare one is malformed — never guess
    // which task to delete. Blocks the turn: the CLI does the whole move.
    //
    // `--force` is the CONFIRMATION, and it has to be parsed here rather than
    // left to the model: this hook dispatches and then blocks, so there is no
    // turn in which a model could ask. Without it the CLI reports what it would
    // delete and deletes nothing.
    const words = (remove[1] || "").trim().split(/\s+/).filter(Boolean)
    const id = unquote(words.find((w) => !w.startsWith("-")) || "")
    if (!id) return { usage: "Usage: /agentic-workflow:engineering remove <id> [--force]." }
    const force = words.some((w) => w === "--force" || w === "-f")
    return { argv: ["gate", "remove", id, ...(force ? ["--force"] : [])] }
  }
  return null
}
