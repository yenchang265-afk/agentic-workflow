/**
 * Pure decision for the SubagentStop verdict guard (check-verdict-guard).
 *
 * A check stage (VERIFY/REVIEW/triage/…) must record its verdict via the
 * `loop_verdict` MCP tool — prose is untrusted and a missing call is what the
 * loop otherwise records as FAIL, silently burning a rebuild iteration on a
 * stage that may have passed. The stage marker (.stage.json) carries
 * `check: true` and `verdictRecorded: false` until loop_verdict lands; when a
 * check subagent stops without it, the guard blocks the stop ONCE (exit 2
 * feeds the reminder back to the subagent). A second stop is always allowed —
 * a subagent whose tool is genuinely unreachable must never be trapped; the
 * MCP server's no-verdict retry then takes over.
 */

/** What the guard should do: "allow", or "nag" (block once and write the sentinel). */
export const decideVerdictGuard = (marker, nagAlreadyFired) => {
  if (!marker || marker.check !== true) return "allow" // no loop / not a check stage
  if (marker.verdictRecorded === true) return "allow" // loop_verdict already landed
  return nagAlreadyFired ? "allow" : "nag"
}

/** The reminder fed back to the check subagent on the blocked stop. */
export const nagMessage = (stage) =>
  `agentic-loop: this ${String(stage ?? "check").toUpperCase()} stage recorded no verdict — call the loop_verdict MCP tool now ` +
  `(mcp__agentic-loop__loop_verdict or, plugin-bundled, mcp__plugin_agentic-loop_agentic-loop__loop_verdict) ` +
  `with stage: "${String(stage ?? "check")}" and verdict PASS/FAIL/ERROR. A verdict in prose is ignored. ` +
  `If the tool is not in your tool list, state that explicitly in your final message and finish.`
