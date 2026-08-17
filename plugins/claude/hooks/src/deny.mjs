/**
 * Bash-denial telemetry for the backlog doctor — the hook-side twin of
 * `@agentic-workflow/core/workflow/deny-log` (`.deny-log.jsonl` under
 * `<tasksDir>/runs/`, one JSON object per line, shared by every host).
 *
 * Written at the point the check-stage guard DENIES a bash command: that
 * refusal used to survive only as a block message in a stage transcript, so
 * every allowlist starvation was diagnosed by transcript archaeology. Doctor
 * aggregates this file instead.
 *
 * Telemetry, never control plane — nothing reads it to decide anything — and
 * best-effort throughout: a denial that fails to record still blocks, and an
 * over-cap file stops growing rather than growing without bound (the byte cap
 * mirrors core's DENY_LOG_MAX_BYTES; doctor names the overflow and
 * `doctor fix` clears the file). Dependency-free beyond node built-ins so it
 * bundles into the hook, matching ./evidence.mjs.
 */
import fs from "node:fs"
import path from "node:path"

/** Basename under `<tasksDir>/runs/` — must match core's DENY_LOG_FILE. */
export const DENY_LOG_FILE = ".deny-log.jsonl"

/** Byte cap past which appends stop — must match core's DENY_LOG_MAX_BYTES. */
export const DENY_LOG_MAX_BYTES = 1024 * 1024

/**
 * Append one denial record. Never throws; every failure path leaves the file
 * as it was.
 */
export const noteDeny = (runsDirPath, host, marker, command) => {
  try {
    const file = path.join(runsDirPath, DENY_LOG_FILE)
    try {
      if (fs.statSync(file).size > DENY_LOG_MAX_BYTES) return
    } catch {
      /* no file yet — first append creates it */
    }
    const entry = {
      ts: new Date().toISOString(),
      host: String(host ?? ""),
      kind: typeof marker?.kind === "string" ? marker.kind : "",
      stage: typeof marker?.stage === "string" ? marker.stage : "",
      command: String(command ?? ""),
    }
    if (!entry.command.trim()) return
    // Create `runs/` rather than ENOENT into the catch below — see core's
    // `appendDenyEntry`, whose twin this is.
    fs.mkdirSync(runsDirPath, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + "\n")
  } catch {
    /* best-effort — telemetry must never change what the guard does */
  }
}
