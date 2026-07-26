/**
 * Pure decision for the SubagentStop verdict guard (check-verdict-guard).
 *
 * A check stage (VERIFY/REVIEW/triage/…) must record its verdict via the
 * `workflow_verdict` MCP tool — prose is untrusted and a missing call is what the
 * loop otherwise records as FAIL, silently burning a rebuild iteration on a
 * stage that may have passed. The host's stage marker carries
 * `check: true` and `verdictRecorded: false` until workflow_verdict lands; when a
 * check subagent stops without it, the guard blocks the stop ONCE (exit 2
 * feeds the reminder back to the subagent). A second stop is always allowed —
 * a subagent whose tool is genuinely unreachable must never be trapped; the
 * MCP server's no-verdict retry then takes over.
 */

/** What the guard should do: "allow", or "nag" (block once and write the sentinel). */
export const decideVerdictGuard = (marker, nagAlreadyFired) => {
  if (!marker || marker.check !== true) return "allow" // no loop / not a check stage
  if (marker.verdictRecorded === true) return "allow" // workflow_verdict already landed
  return nagAlreadyFired ? "allow" : "nag"
}

/**
 * The reminder fed back to the check subagent on the blocked stop.
 *
 * `aliases` names the tool as the host actually surfaces it. Qwen registers
 * MCP tools with the identical `mcp__<server>__<tool>` spelling, so only
 * Claude's extra plugin-bundled alias varies.
 */
export const nagMessage = (stage, aliases = "mcp__agentic-workflow__workflow_verdict or, plugin-bundled, mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict") =>
  `agentic-workflow: this ${String(stage ?? "check").toUpperCase()} stage recorded no verdict — call the workflow_verdict MCP tool now ` +
  `(${aliases}) ` +
  `with stage: "${String(stage ?? "check")}" and verdict PASS/FAIL/ERROR. A verdict in prose is ignored. ` +
  `If the tool is not in your tool list, state that explicitly in your final message and finish.`
