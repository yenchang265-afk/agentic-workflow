/**
 * The PreToolUse wire protocol, shared by every hook that speaks it.
 *
 * Extracted so the guard and the spawn-model stamp emit a byte-identical
 * envelope. Two hooks hand-rolling this JSON is how one of them ends up
 * emitting `permissionDecision` by accident — see `rewriteInput` for why that
 * would be a privilege escalation rather than a cosmetic difference.
 *
 * Dependency-free (no imports at all) so it can be bundled into any hook.
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */

/** Read the hook's stdin payload to completion. */
export const readStdin = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

export const allow = () => process.exit(0)

export const block = (reason) => {
  process.stderr.write(reason + "\n")
  process.exit(2)
}

/**
 * Let the call proceed with CORRECTED input. `updatedInput` REPLACES
 * `tool_input` wholesale before the tool executes — so callers must spread the
 * original (`{ ...ti, field: value }`), never pass a partial object.
 *
 * That is what lets the worktree pin fix a missing `cd <wt> && ` prefix or a
 * main-tree file path instead of refusing and making the agent guess again (the
 * retry loop was the isolation's worst failure mode), and what lets the spawn
 * stamp bind a configured model without asking the model to cooperate.
 *
 * Deliberately NO `permissionDecision`: this envelope's job is to correct the
 * input, not to grant permission. Emitting `"allow"` would auto-approve every
 * rewritten call, so something the user would normally be prompted about would
 * run unprompted purely because a hook touched it — strictly more privilege
 * than the block-only guard it replaces. Omitting the field leaves the normal
 * permission flow to rule on the corrected input.
 *
 * The host schema-validates the result: an `updatedInput` the tool's schema
 * rejects fails the WHOLE call rather than being ignored, so never stamp a
 * value you have not validated.
 */
export const rewriteInput = (updatedInput) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }) + "\n")
  process.exit(0)
}
