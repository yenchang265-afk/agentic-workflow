/**
 * Pure prompt→gate-argv parsing for the UserPromptSubmit gate hook
 * (gate-command.mjs). Split out so it can be unit-tested without running the
 * hook's stdin/spawn machinery.
 *
 * The gate verbs live under the single `/agent-loop` command:
 *   approve [id]   (aliases: ok, go)      → gate approve-any [id]
 *   approve-plan <id>                     → gate approve-plan <id>
 *   reject [id] [reason] (redo, replan)   → gate reject-any [id] [reason...]
 * plus the `GATE-DISPATCH:` sentinel a command template may emit once
 * expanded — covering both possible UserPromptSubmit interception points
 * (pre- or post-expansion). Longest alternative first — `approve-plan` is
 * tried before `approve` (otherwise `approve` matches and `-plan` leaks into
 * the id; the `(?!-)` guard backstops the same collision inside APPROVE).
 */
const VERB = "(approve-plan|replan|approve)"
const SENTINEL = new RegExp(`GATE-DISPATCH:\\s*${VERB}\\b[ \\t]*(\\S+)?[ \\t]*(.*)$`, "im")

// The folder-driven gate verbs of the merged /agent-loop command — subcommands,
// NOT top-level words (so they never collide with a reserved `/approve`). The
// id is optional on approve/reject: a bare `/agent-loop approve` auto-resolves
// the single awaiting task (draft approval always needs the explicit id — the
// CLI's approve-any enforces that).
const APPROVE_PLAN = /(?:^|\s|\/)agent-loop\s+approve-plan\b[ \t]*(\S+)?[ \t]*(.*)$/im
const APPROVE = /(?:^|\s|\/)agent-loop\s+(?:approve(?!-)|ok|go)\b[ \t]*(.*)$/im
const REJECT = /(?:^|\s|\/)agent-loop\s+(?:reject|redo|replan)\b[ \t]*(.*)$/im

/**
 * Build the `gate` CLI argv from the prompt, or null when it is not a gate
 * command. Sentinel and approve-plan forms require an id (a bare one is
 * malformed — passed through so the model reports usage); the folder-driven
 * shortcuts do not.
 */
export const gateArgsFor = (prompt) => {
  const sentinel = prompt.match(SENTINEL)
  if (sentinel) {
    const id = (sentinel[2] || "").trim()
    if (!id) return { passThrough: true } // malformed sentinel gate — let the model report it
    const reason = (sentinel[3] || "").trim()
    return { argv: ["gate", sentinel[1], id, ...(reason ? [reason] : [])] }
  }
  const plan = prompt.match(APPROVE_PLAN)
  if (plan) {
    const id = (plan[1] || "").trim()
    if (!id) return { passThrough: true } // approve-plan needs an explicit id
    return { argv: ["gate", "approve-plan", id] }
  }
  const approve = prompt.match(APPROVE)
  if (approve) {
    // approve takes an optional id (first token); extra words are ignored.
    const id = (approve[1] || "").trim().split(/\s+/).filter(Boolean)[0] || ""
    return { argv: ["gate", "approve-any", ...(id ? [id] : [])] }
  }
  const reject = prompt.match(REJECT)
  if (reject) {
    const words = (reject[1] || "").trim().split(/\s+/).filter(Boolean)
    return { argv: ["gate", "reject-any", ...words] }
  }
  return null
}
