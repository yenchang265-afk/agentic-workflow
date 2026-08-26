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
 * - the spawn TIMED OUT (the hook's own deadline killed it) → BLOCK. A timeout
 *   is not a crash: the CLI was mid-flight, so the move may already have
 *   LANDED with the GateResult lost in the kill — failing open would invite
 *   the model to run the verb again via MCP, a double-move on exactly the
 *   slow trees that time out. A false block costs one typed command after a
 *   manual check; the asymmetry is the same as decideGateOutcome's not-built
 *   arm.
 * - anything else (spawn error, crash, half-built dist — non-zero exit with
 *   no GateResult on stdout) → FAIL OPEN, per the hook's documented contract.
 */

/** The actionable block message when the plugin's MCP server was never built. */
export const missingDistMessage = (label, installer = "plugins/claude/install.sh") =>
  `agentic-workflow: can't run the "${label}" gate — the plugin is not built ` +
  `(mcp-server/dist/server.js is missing). Run ${installer}, then retry.`

/**
 * Decide the hook's action from the spawn result. Returns
 * `{ action: "pass" }` or `{ action: "block", message, ok, data? }` — `data` is
 * the GateResult's machine-readable half, present only when the CLI sent one.
 * `label` is the human-readable gate ("approve-any f7k3") for fallback text.
 */
export const decideGateOutcome = ({ distExists, spawnError, status, stdout }, label, installer) => {
  if (!distExists) return { action: "block", message: missingDistMessage(label, installer), ok: false }
  // Timed out — the CLI was killed mid-flight, so the move may or may not have
  // landed. Block (see the contract above); never fall through to the fail-open
  // arm, whose premise ("the CLI never got to the gate logic") does not hold.
  if (spawnError && spawnError.code === "ETIMEDOUT")
    return {
      action: "block",
      message:
        `agentic-workflow: the "${label}" gate timed out before reporting. The move may or may not have landed — ` +
        "check which status folder the task sits in (status, or the backlog under docs/tasks/) before retrying.",
      ok: false,
    }
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
    // `data` (the GateResult's machine-readable half: `{gate, id, …}`) is what
    // the caller branches on to hand the turn back for a follow-up question.
    // Attach it ONLY when the CLI really sent an object — a plain-object check,
    // so null and arrays are dropped rather than passed on for `.gate` to be
    // read off — and omit the key entirely otherwise, which is what keeps this
    // additive for every caller that compares whole outcomes.
    const { data } = parsed
    const usable = !!data && typeof data === "object" && !Array.isArray(data)
    return { action: "block", message: parsed.message, ok: parsed.ok === true, ...(usable ? { data } : {}) }
  }
  // The CLI ran but produced no GateResult. Non-zero ⇒ it crashed before the
  // gate logic could speak (stale dist, dependency error) — fail open so the
  // model can still try the MCP path and report honestly. Zero ⇒ it ran to
  // completion silently (shouldn't happen) — block with the generic outcome.
  if (status !== 0) return { action: "pass" }
  return { action: "block", message: `Gate ${label} done.`, ok: true }
}
