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
 *
 * The last clause is not politeness. The stage name here comes from the MARKER —
 * the stage the loop ARMED — and the guard cannot see which subagent is stopping.
 * A subagent spawned out of step (the failure check-spawn-stage now blocks) would
 * therefore be told to record under the armed stage's name, and that call is
 * ACCEPTED: a REVIEW's findings would be filed as the VERIFY verdict, which is
 * worse than the missing verdict this nag exists to prevent. Recording nothing is
 * always the safe answer, so say so rather than let it be inferred.
 */
export const nagMessage = (stage, aliases = "mcp__agentic-workflow__workflow_verdict or, plugin-bundled, mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict") =>
  `agentic-workflow: this ${String(stage ?? "check").toUpperCase()} stage recorded no verdict — call the workflow_verdict MCP tool now ` +
  `(${aliases}) ` +
  `with stage: "${String(stage ?? "check")}" and verdict PASS/FAIL/ERROR. A verdict in prose is ignored. ` +
  `If the tool is not in your tool list, state that explicitly in your final message and finish. ` +
  `If "${String(stage ?? "check")}" is NOT the stage you were asked to run, record no verdict at all — say which stage you ran ` +
  `in your final message instead. Recording under another stage's name would file your findings as that stage's verdict.`
