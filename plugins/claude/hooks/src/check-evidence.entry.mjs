#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse evidence recorder. `npm run build:hooks`
 * (scripts/build-hooks.mjs) bundles this into ../check-evidence.mjs; never edit
 * the bundled output by hand.
 *
 * It records the INSPECTION tools (Read/Grep/Glob and their per-host
 * equivalents) into the live check stage's proof-of-work ledger, so
 * `workflow_verdict` can reject a PASS the stage did no work for
 * (@agentic-workflow/core/workflow/evidence).
 *
 * **Why this is not part of check-stage-guard.** That guard's matcher is
 * `Bash|Edit|Write|…|mcp__.*` — read tools never reach it, so a REVIEW stage,
 * whose work is almost entirely reading, would leave an empty ledger and have
 * every honest PASS rejected. Widening the guard's matcher would fix that by
 * putting every file read inside a 300-line security guard's blast radius: a
 * bug there would then block reads, and the guard fails CLOSED by design.
 * Recording is a different job with the opposite failure preference, so it gets
 * its own hook and its own matcher, non-overlapping with both existing ones.
 *
 * Fails OPEN, always: it can only ever `allow`. A recorder that blocked a tool
 * call over its own bookkeeping would be strictly worse than a weaker gate —
 * and unlike the guard, an unknown host here costs a missing observation, not a
 * disarmed control.
 *
 * Contract: exit 0 allows. This hook never blocks and never rewrites input.
 */
import { dialectFor, hostFor } from "./dialect.mjs"
import { evidenceEntry, noteEvidence } from "./evidence.mjs"
import { readMarker, runsDir } from "./marker.mjs"
import { allow, readStdin as read } from "./pretooluse.mjs"

const main = async () => {
  let input
  try {
    input = JSON.parse(await read())
  } catch {
    return allow()
  }
  const d = dialectFor(hostFor())
  if (!d) return allow()
  const cwd = input.cwd || process.cwd()
  const marker = readMarker(cwd, d.stageMarkerFile)
  // No marker means no loop stage; a work stage records no verdict, so it has
  // nothing to corroborate and its reads are not the loop's business.
  if (!marker || marker.check !== true) return allow()
  noteEvidence(runsDir(cwd), d.evidenceFile, String(marker.stage ?? ""), evidenceEntry(d, input.tool_name, input.tool_input || {}))
  return allow()
}

main()
