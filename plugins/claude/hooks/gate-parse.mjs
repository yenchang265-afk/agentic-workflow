/**
 * Pure prompt→gate-argv parsing for the UserPromptSubmit gate hook
 * (gate-command.mjs). Split out so it can be unit-tested without running the
 * hook's stdin/spawn machinery.
 *
 * The gate verbs live under the engineering command, typed as
 * `/agentic-workflow:engineering` (or the bare `/engineering` disambiguation
 * Claude Code offers for plugin commands):
 *   approve [id]           → gate approve-any [id]   (unified folder-driven gate)
 *   replan [id] [reason]   → gate reject-any [id] [reason...]
 *   abandon <id> [reason]  → gate abandon <id> …     (→ abandoned/; id required)
 *   remove <id> [--force]  → gate remove <id> …      (hard-delete; id required)
 * plus the `GATE-DISPATCH:` sentinel a command template may emit once
 * expanded — covering both possible UserPromptSubmit interception points
 * (pre- or post-expansion). Longest alternative first inside VERB —
 * `approve-plan` (sentinel-only, kept for older templates) is tried before
 * `approve` so `-plan` can't leak into the id.
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
const VERB = "(approve-plan|replan|approve)"
// The sentinel is the ONE form that may appear anywhere: a command template
// emits it once expanded, so it arrives mid-body by construction. It is also
// the form no human types, which is what makes that safe.
const SENTINEL = new RegExp(`GATE-DISPATCH:\\s*${VERB}\\b[ \\t]*(\\S+)?[ \\t]*(.*)$`, "im")

// The gate verbs of /agentic-workflow:engineering — subcommands, NOT top-level
// words (so they never collide with a reserved `/approve`). The id is optional
// on approve/replan: a bare `approve` auto-resolves the single awaiting task
// (loop gates first, a lone draft as fallback — the CLI's approve-any owns that
// priority).
//
// `(?![-\\w])` closes the command name so a sibling command cannot inherit
// engineering's verbs or its instructions: without it `/engineering-notes` read
// as engineering plus the verb `-notes`. Same guard, same reason, as ADHOC_PLAN.
const CMD = "\\/(?:agentic-workflow:)?engineering(?![-\\w])"
// `^\\s*` — the command opens the prompt; see the header for why anything later
// in the prompt is content rather than an invocation.
const AT_START = "^\\s*"
const APPROVE = new RegExp(`${AT_START}${CMD}\\s+approve(?!-)\\b[ \\t]*(.*)`, "i")
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
  return (match[1] || "").trim().toLowerCase() || "status"
}

/**
 * Build the `gate` CLI argv from the prompt, or null when it is not a gate
 * command. The sentinel form requires an id (a bare one is malformed —
 * passed through so the model reports usage); the folder-driven verbs do not.
 *
 * `continueTurn` marks a dispatch whose success must NOT block the model: the
 * CLI did the deterministic part, and the model still has work to do.
 */
export const gateArgsFor = (prompt) => {
  const sentinel = prompt.match(SENTINEL)
  if (sentinel) {
    const id = (sentinel[2] || "").trim()
    if (!id) return { passThrough: true } // malformed sentinel gate — let the model report it
    const reason = (sentinel[3] || "").trim()
    return { argv: ["gate", sentinel[1], id, ...(reason ? [reason] : [])] }
  }
  const approve = prompt.match(APPROVE)
  if (approve) {
    // approve takes an optional id (first token); extra words are ignored.
    const id = (approve[1] || "").trim().split(/\s+/).filter(Boolean)[0] || ""
    return { argv: ["gate", "approve-any", ...(id ? [id] : [])] }
  }
  const replan = prompt.match(REPLAN)
  if (replan) {
    const words = (replan[1] || "").trim().split(/\s+/).filter(Boolean)
    return { argv: ["gate", "reject-any", ...words] }
  }
  const retask = prompt.match(RETASK)
  if (retask) {
    // retask always names its target; a bare one is malformed — let the model
    // report the usage error rather than guessing which task to un-approve.
    const id = (retask[1] || "").trim().split(/\s+/).filter(Boolean)[0] || ""
    if (!id) return { passThrough: true }
    return { argv: ["gate", "retask", id], continueTurn: true }
  }
  const abandon = prompt.match(ABANDON)
  if (abandon) {
    const words = (abandon[1] || "").trim().split(/\s+/).filter(Boolean)
    const id = words[0] || ""
    if (!id) return { passThrough: true }
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
    const id = words.find((w) => !w.startsWith("-")) || ""
    if (!id) return { passThrough: true }
    const force = words.some((w) => w === "--force" || w === "-f")
    return { argv: ["gate", "remove", id, ...(force ? ["--force"] : [])] }
  }
  return null
}
