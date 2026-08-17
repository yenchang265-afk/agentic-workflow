import fs from "node:fs"
import path from "node:path"
import { commandAllowed } from "../task/write-backstop.js"

/**
 * Bash-denial telemetry for the backlog doctor.
 *
 * Allowlist starvation has been diagnosed by hand four separate times (mvn and
 * gradle argv order, pnpm workspace selectors, a rewriting proxy's prefix), and
 * every time the evidence was buried in a stage transcript: OpenCode's
 * DeniedError dumps every rule pattern-unfiltered, and the Claude/Qwen guard's
 * block message names only the one command. So the enforcement seams now
 * APPEND each denial here — `<tasksDir>/runs/.deny-log.jsonl`, one JSON object
 * per line — and `doctor` aggregates the file into the report that used to
 * take transcript archaeology: which commands a stage refused, how often, and
 * the exact config key that would admit them.
 *
 * Telemetry, never control plane: nothing reads this file to decide anything,
 * which is why one shared file serves every host (the per-host split that the
 * stage marker and evidence ledger need exists to stop cross-host corruption
 * of a verdict input — a denial count has no verdict to corrupt). Writers are
 * best-effort throughout: a denial that fails to record still blocks, and a
 * record that fails to parse is skipped, never fatal.
 */

/** Basename under `<tasksDir>/runs/`. */
export const DENY_LOG_FILE = ".deny-log.jsonl"

/** Absolute path of the deny log. Pure. */
export const denyLogPath = (directory: string, tasksDir: string): string => path.join(directory, tasksDir, "runs", DENY_LOG_FILE)

/**
 * Entries read back per doctor run (last-N wins: recent denials are the ones
 * the operator can still act on). Also the writer's soft size bound — see
 * `appendDenyEntry`.
 */
export const DENY_LOG_MAX = 500

/** Bytes past which the writer stops appending rather than growing the file
 *  without bound. Doctor names the overflow; `doctor fix` clears it. */
export const DENY_LOG_MAX_BYTES = 1024 * 1024

export interface DenyEntry {
  /** ISO timestamp of the denial. */
  readonly ts: string
  /** Host whose enforcement seam denied it. */
  readonly host: string
  /** Workflow kind of the live loop ("" when unknown). */
  readonly kind: string
  /** Stage the loop was at ("" when unknown). */
  readonly stage: string
  /** The denied bash command, verbatim. */
  readonly command: string
}

/**
 * Append one denial. Best-effort by contract: every failure path (unwritable
 * runs/, missing dir, an over-cap file) returns silently — bookkeeping must
 * never change what the enforcement seam does with the call.
 */
export const appendDenyEntry = (directory: string, tasksDir: string, entry: DenyEntry): void => {
  const file = denyLogPath(directory, tasksDir)
  try {
    try {
      if (fs.statSync(file).size > DENY_LOG_MAX_BYTES) return
    } catch {
      /* no file yet — first append creates it */
    }
    // `runs/` may not exist yet, and the append would then ENOENT into the
    // catch-all below — silently, which is the one thing telemetry meant to end
    // transcript archaeology must not do. Reachable exactly where it costs most:
    // PLAN never snapshots, so a first-ever loop that hits a bash denial during
    // PLAN can be the first thing to want this directory. Every other `runs/`
    // writer already creates it (stage-marker.ts, persist.ts, plan-request.ts).
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + "\n")
  } catch {
    /* best-effort — telemetry must never fail the denial */
  }
}

/** Parse one line into an entry, or null. Pure. */
export const parseDenyLine = (line: string): DenyEntry | null => {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== "object") return null
    const p = parsed as Record<string, unknown>
    if (typeof p.command !== "string" || !p.command.trim()) return null
    return {
      ts: typeof p.ts === "string" ? p.ts : "",
      host: typeof p.host === "string" ? p.host : "",
      kind: typeof p.kind === "string" ? p.kind : "",
      stage: typeof p.stage === "string" ? p.stage : "",
      command: p.command,
    }
  } catch {
    return null
  }
}

/**
 * The last `DENY_LOG_MAX` parseable entries, oldest first. A missing or
 * unreadable file is an empty report, never an error — doctor must stay
 * usable on a repo that has never denied anything.
 */
export const readDenyLog = (directory: string, tasksDir: string): DenyEntry[] => {
  let raw: string
  try {
    raw = fs.readFileSync(denyLogPath(directory, tasksDir), "utf8")
  } catch {
    return []
  }
  const entries: DenyEntry[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const parsed = parseDenyLine(t)
    if (parsed) entries.push(parsed)
  }
  return entries.slice(-DENY_LOG_MAX)
}

/** Remove the log (doctor fix's "telemetry acknowledged"). True when a file was
 *  actually deleted. Never throws. */
export const clearDenyLog = (directory: string, tasksDir: string): boolean => {
  try {
    fs.unlinkSync(denyLogPath(directory, tasksDir))
    return true
  } catch {
    return false
  }
}

/** One aggregated line of the doctor report: a distinct denied command within
 *  one kind+stage, with the config change that would admit it. */
export interface DenyFinding {
  readonly kind: string
  readonly stage: string
  readonly command: string
  readonly count: number
  /** Actionable config suggestion, or null when none can be derived
   *  (e.g. the stage's allowlist could not be resolved). */
  readonly suggestion: string | null
}

/** Resolve a stage's effective allowlist globs, or null when unknown.
 *  Hosts pass a manifest-backed lookup; the aggregation stays pure. */
export type StageGlobsLookup = (kind: string, stage: string) => readonly string[] | null

const firstTokens = (command: string): string[] => command.trim().split(/\s+/u)

/**
 * What no allowlist change can fix — the refusal came from somewhere else.
 * Shared by the two arms that reach it so they cannot word it differently.
 */
const NOT_THE_ALLOWLIST =
  "no allowlist change admits this — it was refused by a write backstop (a push to a protected branch, a PR mutation, a mutating `find`) " +
  "or by a proxy that RENAMES the command, which no derived glob can cover"

/**
 * The config key that would admit `command` on a stage whose EFFECTIVE globs are
 * `globs` (`stageBashGlobs` — the same list the seam enforces, prefix twins
 * included), derived mechanically. No per-ecosystem table: the table is the
 * thing that went stale four times.
 *
 * 1. Globs that already admit the command mean the allowlist is not what
 *    refused it, so no allowlist advice can be right. Same for an EMPTY list,
 *    which means the stage declares no allowlist at all and is unrestricted.
 *    This arm is what makes (2) sound: without it, a denial under an
 *    already-configured `bashAllowlistPrefix` was diagnosed as needing that
 *    very prefix — advice the operator applies and nothing changes.
 * 2. If dropping the leading one or two tokens yields a command the stage
 *    ALREADY allows, the denial is a rewriting proxy's prefix — suggest
 *    `bashAllowlistPrefix`, which re-expresses the existing globs and widens
 *    nothing.
 * 3. Otherwise suggest a `bashAllowlistExtra` glob shaped from the command's
 *    first two tokens: `<tool> <next> *` (or `<tool> *` for a bare tool). The
 *    second token stays even when it is flag-shaped — `pnpm --filter *` is
 *    narrower than `pnpm *`, and an extra widens the stage's scope boundary,
 *    so the suggestion always shows the narrowest mechanical form and leaves
 *    breadth as the operator's call.
 *
 * `null` globs are the un-resolvable stage (an unknown kind, a manifest that no
 * longer declares it): nothing can be proven about it, so it keeps the
 * mechanical (3) — which is what this said before any of the arms existed.
 *
 * Pure.
 */
export const suggestFor = (command: string, globs: readonly string[] | null): string | null => {
  const tokens = firstTokens(command)
  if (!tokens.length || !tokens[0]) return null
  if (globs) {
    if (!globs.length) return `${NOT_THE_ALLOWLIST} — this stage declares no bash allowlist, so it restricts nothing`
    if (commandAllowed(command, globs)) return `${NOT_THE_ALLOWLIST} — this stage's effective allowlist already admits it`
    for (const hop of [1, 2]) {
      if (tokens.length <= hop) break
      const prefix = tokens.slice(0, hop).join(" ")
      const stripped = tokens.slice(hop).join(" ")
      if (commandAllowed(stripped, globs)) {
        return `add "${prefix}" to bashAllowlistPrefix (the stage already allows the command it wraps)`
      }
    }
  }
  const sub = tokens[1] ? ` ${tokens[1]}` : ""
  return `add "${tokens[0]}${sub} *" to bashAllowlistExtra if this command should be allowed`
}

/**
 * Aggregate raw entries into per-(kind, stage, command) findings, most-denied
 * first. Pure given the lookup.
 */
export const aggregateDenials = (entries: readonly DenyEntry[], globsFor: StageGlobsLookup): DenyFinding[] => {
  const groups = new Map<string, { entry: DenyEntry; count: number }>()
  for (const entry of entries) {
    const key = `${entry.kind}\u0000${entry.stage}\u0000${entry.command}`
    const seen = groups.get(key)
    if (seen) groups.set(key, { entry, count: seen.count + 1 })
    else groups.set(key, { entry, count: 1 })
  }
  const findings: DenyFinding[] = []
  for (const { entry, count } of groups.values()) {
    findings.push({
      kind: entry.kind,
      stage: entry.stage,
      command: entry.command,
      count,
      suggestion: suggestFor(entry.command, globsFor(entry.kind, entry.stage)),
    })
  }
  return findings.sort((a, b) => b.count - a.count)
}

/** Human-facing report lines, one per finding — empty for an empty log. Pure. */
export const formatDenyFindings = (findings: readonly DenyFinding[]): string[] =>
  findings.map((f) => {
    const where = [f.kind || "unknown-kind", f.stage ? f.stage.toUpperCase() : "unknown-stage"].join(" ")
    const base = `${where} denied ${f.count === 1 ? "once" : `${f.count.toString()}×`}: ${f.command}`
    return f.suggestion ? `${base} — ${f.suggestion}` : base
  })
