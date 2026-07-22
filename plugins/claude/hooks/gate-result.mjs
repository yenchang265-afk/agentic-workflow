/**
 * Pure decision logic for the gate hook (gate-command.mjs): given what the
 * spawned `gate` CLI did, decide whether to BLOCK the turn (the gate ran and
 * spoke), FAIL OPEN (let the model + MCP-tool path handle it), or block with
 * the not-built diagnosis. Split out so it can be unit-tested without the
 * hook's stdin/spawn machinery, in the same style as gate-parse.mjs.
 *
 * The rules:
 * - dist missing → BLOCK with an actionable "not built" message. Failing open
 *   would be pointless: the MCP fallback launches the very same missing
 *   dist/server.js, so the model can only flounder or fabricate success.
 * - the CLI ran and its last stdout line parses as a GateResult
 *   ({ok, message}) → BLOCK with that verdict, success or refusal alike.
 * - anything else (spawn error, crash, half-built dist — non-zero exit with
 *   no GateResult on stdout) → FAIL OPEN, per the hook's documented contract.
 */

/** The actionable block message when the plugin's MCP server was never built. */
export const missingDistMessage = (label) =>
  `agentic-workflow: can't run the "${label}" gate — the plugin is not built ` +
  `(mcp-server/dist/server.js is missing). Run plugins/claude/install.sh, then retry.`

/**
 * Decide the hook's action from the spawn result. Returns
 * `{ action: "pass" }` or `{ action: "block", message, ok }`.
 * `label` is the human-readable gate ("approve-any f7k3") for fallback text.
 */
export const decideGateOutcome = ({ distExists, spawnError, status, stdout }, label) => {
  if (!distExists) return { action: "block", message: missingDistMessage(label), ok: false }
  // Could not even run node (binary missing, spawn failure) — fail open.
  if (spawnError || status === null || status === undefined) return { action: "pass" }
  let parsed = null
  try {
    const last = (stdout || "").trim().split("\n").filter(Boolean).pop()
    parsed = last ? JSON.parse(last) : null
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed.message === "string") {
    return { action: "block", message: parsed.message, ok: parsed.ok === true }
  }
  // The CLI ran but produced no GateResult. Non-zero ⇒ it crashed before the
  // gate logic could speak (stale dist, dependency error) — fail open so the
  // model can still try the MCP path and report honestly. Zero ⇒ it ran to
  // completion silently (shouldn't happen) — block with the generic outcome.
  if (status !== 0) return { action: "pass" }
  return { action: "block", message: `Gate ${label} done.`, ok: true }
}
