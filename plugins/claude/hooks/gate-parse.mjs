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
 *   remove <id>            → gate remove <id>        (hard-delete; id required)
 * plus the `GATE-DISPATCH:` sentinel a command template may emit once
 * expanded — covering both possible UserPromptSubmit interception points
 * (pre- or post-expansion). Longest alternative first inside VERB —
 * `approve-plan` (sentinel-only, kept for older templates) is tried before
 * `approve` so `-plan` can't leak into the id.
 *
 * Unlike the old `agent-loop` prefix, `engineering` is an ordinary English
 * word — so the command match REQUIRES the leading slash form. Prose like
 * "the engineering approve step" must never fire a gate move.
 */
const VERB = "(approve-plan|replan|approve)"
const SENTINEL = new RegExp(`GATE-DISPATCH:\\s*${VERB}\\b[ \\t]*(\\S+)?[ \\t]*(.*)$`, "im")

// The two gate verbs of /agentic-workflow:engineering — subcommands, NOT top-level
// words (so they never collide with a reserved `/approve`). The id is optional
// on both: a bare `approve` auto-resolves the single awaiting task (loop gates
// first, a lone draft as fallback — the CLI's approve-any owns that priority).
const CMD = "\\/(?:agentic-workflow:)?engineering"
const APPROVE = new RegExp(`(?:^|\\s)${CMD}\\s+approve(?!-)\\b[ \\t]*(.*)$`, "im")
const REPLAN = new RegExp(`(?:^|\\s)${CMD}\\s+replan\\b[ \\t]*(.*)$`, "im")
// retask is the one HYBRID verb: its move is deterministic (queued/ → draft/, or
// a refusal) but the reshape that follows is an interview only the model can
// run. So it dispatches like a gate verb and then, on success, hands the turn
// back instead of blocking it — see `continueTurn` below.
const RETASK = new RegExp(`(?:^|\\s)${CMD}\\s+retask\\b[ \\t]*(.*)$`, "im")
// remove hard-deletes a task. Fully deterministic like approve (nothing for the
// model to do after), so it BLOCKS the turn — but it always requires an explicit
// id: there is no folder-driven "remove the awaiting one" (too easy to delete
// the wrong task), so a bare `remove` passes through for the model to report.
const REMOVE = new RegExp(`(?:^|\\s)${CMD}\\s+remove\\b[ \\t]*(.*)$`, "im")

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
  const remove = prompt.match(REMOVE)
  if (remove) {
    // remove always names its target; a bare one is malformed — never guess
    // which task to delete. Blocks the turn: the CLI does the whole move.
    const id = (remove[1] || "").trim().split(/\s+/).filter(Boolean)[0] || ""
    if (!id) return { passThrough: true }
    return { argv: ["gate", "remove", id] }
  }
  return null
}
