import path from "node:path"
import { writeFileAtomic } from "../fsatomic.js"
import type { Shell } from "../host.js"
import { pidAlive } from "../liveness.js"
import type { WorkflowState } from "./state.js"

/**
 * The live-stage marker: written under `<tasksDir>/runs/` while a stage runs and
 * removed when the drive ends. Out-of-process observers (the admin hub's driving
 * oracle, its doctor, the live board badge) read it to answer "what is this loop
 * doing RIGHT NOW" — before it existed, the hub could see OpenCode-driven work
 * only through claim markers, so its doctor had to skip claim release wholesale
 * whenever a watcher lease was live.
 *
 * **One file per host, never a shared one.** A marker is not only telemetry: the
 * Claude host's is a control-plane input to its PreToolUse hooks (stage
 * allowlists, worktree pinning, deadlines), and the Qwen host's is the same to
 * its own. A loop driven by one host runs its stages where the other host's
 * hooks do not exist, so writing a shared path would subject a human's
 * concurrent interactive session on the *other* host to guards meant for the
 * loop's agents — and already-built hook bundles could not be taught to skip it.
 * A per-host file is inert to every hook but the one that owns it.
 *
 * Claude's marker is the unsuffixed `.stage.json` because it came first and its
 * shipped hook bundles read that literal path; every host added since is
 * suffixed. Don't "tidy" that asymmetry away — renaming it silently disarms
 * every installed Claude hook.
 */

/** The hosts that write a live-stage marker. */
export type StageMarkerHost = "claude" | "opencode" | "qwen"

const MARKER_FILE: Record<StageMarkerHost, string> = {
  claude: ".stage.json",
  opencode: ".stage-opencode.json",
  qwen: ".stage-qwen.json",
}

/**
 * The check-stage proof-of-work ledger, written next to the marker by the host's
 * tool guard and read back by `workflow_verdict` (see `workflow/evidence.ts`).
 *
 * Per host for the same reason the marker is: it is a control-plane input, and a
 * shared path would let one host's interactive session write into another host's
 * live loop's evidence — which here would mean corroborating a PASS with work
 * the stage never did.
 */
const EVIDENCE_FILE: Record<StageMarkerHost, string> = {
  claude: ".stage-evidence.json",
  opencode: ".stage-evidence-opencode.json",
  qwen: ".stage-evidence-qwen.json",
}

/** Basename of a host's evidence ledger under `<tasksDir>/runs/`. Pure. */
export const stageEvidenceFile = (host: StageMarkerHost): string => EVIDENCE_FILE[host]

/** Absolute path of a host's evidence ledger. Pure. */
export const hostStageEvidencePath = (directory: string, tasksDir: string, host: StageMarkerHost): string =>
  path.join(directory, tasksDir, "runs", EVIDENCE_FILE[host])

/**
 * The one-shot SubagentStop nag sentinel: written once a stage's transcript is
 * flagged as missing its `workflow_verdict` call, so the reminder fires only
 * once per stage instead of on every subsequent subagent stop.
 *
 * Per host for the same reason the marker and evidence ledger are — Claude and
 * Qwen share this server/hook source, so an unscoped path let a stale sentinel
 * from one host's run suppress (or falsely arm) the other host's reminder on
 * the same repo. Claude keeps the unsuffixed `.verdict-nag` (same reason
 * `.stage.json` stays unsuffixed — it came first, and its shipped hook
 * bundles read that literal path); every host added since is suffixed.
 * OpenCode does not run this hook at all — no SubagentStop nag exists there —
 * but a value is still declared for parity with the other two per-host maps.
 */
const VERDICT_NAG_FILE: Record<StageMarkerHost, string> = {
  claude: ".verdict-nag",
  opencode: ".verdict-nag-opencode",
  qwen: ".verdict-nag-qwen",
}

/** Basename of a host's verdict-nag sentinel under `<tasksDir>/runs/`. Pure. */
export const verdictNagFile = (host: StageMarkerHost): string => VERDICT_NAG_FILE[host]

/** Absolute path of a host's verdict-nag sentinel. Pure. */
export const hostVerdictNagPath = (directory: string, tasksDir: string, host: StageMarkerHost): string =>
  path.join(directory, tasksDir, "runs", VERDICT_NAG_FILE[host])

/**
 * Every host that writes a marker, in the precedence order an out-of-process
 * observer should read them. At most one loop runs per repo, so precedence only
 * decides a tie that should not happen; the point of the list is that observers
 * iterate it instead of hardcoding a set that silently misses a new host.
 */
export const STAGE_MARKER_HOSTS: readonly StageMarkerHost[] = ["claude", "opencode", "qwen"]

/** Basename of a host's stage marker under `<tasksDir>/runs/`. Pure. */
export const stageMarkerFile = (host: StageMarkerHost): string => MARKER_FILE[host]

/**
 * Absolute path of a host's stage marker. Pure. The single place a marker
 * filename is spelled — a host that builds its own path by hand is one rename
 * away from writing a file nothing reads.
 */
export const hostStageMarkerPath = (directory: string, tasksDir: string, host: StageMarkerHost): string =>
  path.join(directory, tasksDir, "runs", MARKER_FILE[host])

export interface OpencodeStageMarker {
  readonly host: "opencode"
  readonly kind: string
  readonly stage: string
  readonly taskId: string | null
  readonly worktree: string | null
  /** Wall-clock ms deadline of the stage attempt (start + stageTimeoutMinutes); display-only. */
  readonly deadline: number | null
  readonly iteration: number
  /** Writer process id — lets `taskDrivenByStageMarker` treat a SIGKILLed writer's leftover marker as dead. */
  readonly pid: number
}

/** Absolute path of the OpenCode host's stage marker. Pure. */
export const opencodeMarkerPath = (directory: string, tasksDir: string): string =>
  hostStageMarkerPath(directory, tasksDir, "opencode")

/** Build the marker for a stage the driver is about to fire. Pure but for `process.pid`. */
export const opencodeStageMarker = (state: WorkflowState, deadline: number | null): OpencodeStageMarker => ({
  host: "opencode",
  kind: state.kind ?? "engineering",
  stage: state.stage,
  taskId: state.task?.id ?? null,
  worktree: state.git?.worktree ?? null,
  deadline,
  iteration: state.iteration,
  pid: process.pid,
})

/** Write the marker. Best-effort — telemetry must never fail the drive. */
export const writeOpencodeStageMarker = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  marker: OpencodeStageMarker,
): Promise<void> => {
  const dir = path.join(directory, tasksDir, "runs")
  await $`mkdir -p ${dir}`.quiet().nothrow()
  await writeFileAtomic($, opencodeMarkerPath(directory, tasksDir), JSON.stringify(marker))
}

/** Remove the marker. Best-effort; idempotent on an absent file. */
export const clearOpencodeStageMarker = async ($: Shell, directory: string, tasksDir: string): Promise<void> => {
  await $`rm -f ${opencodeMarkerPath(directory, tasksDir)}`.quiet().nothrow()
}

/**
 * Which host's live-stage marker (if any) says a loop is driving `taskId`
 * RIGHT NOW. "Live" means: the marker names the task, its stage deadline has
 * not passed, and — when the marker carries a `pid` — the writer process still
 * exists. A crashed (SIGKILLed) driver leaves its marker on disk, but its pid
 * is gone, so `recover` isn't locked out for the rest of the stage window.
 * Markers from older versions carry no pid and fall back to the deadline alone.
 * Every read is best-effort: a missing or garbled marker reads as "not driven".
 */
/**
 * Whether any host's stage marker names `taskId` at all, live or dead. For a
 * caller that already got null from `taskDrivenByStageMarker`, a marker naming
 * the task is CRASH evidence — a run reached a stage and its writer died — so
 * taking its claim over immediately is safe. No marker at all is ambiguous:
 * a just-claimed live run spends minutes inside its setup window (isolation,
 * stage checks) BEFORE its first marker write, and sweeping its claim there
 * starts a second drive on the same branch — the caller must fall back to
 * claim-stamp staleness instead.
 */
export const taskNamedByStageMarker = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  taskId: string,
): Promise<boolean> => {
  for (const host of STAGE_MARKER_HOSTS) {
    const out = await $`cat ${hostStageMarkerPath(directory, tasksDir, host)}`.quiet().nothrow()
    if (out.exitCode !== 0) continue
    try {
      const m = JSON.parse(out.stdout.toString()) as { taskId?: unknown }
      if (m.taskId === taskId) return true
    } catch {
      continue
    }
  }
  return false
}

export const taskDrivenByStageMarker = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  taskId: string,
  now: number = Date.now(),
): Promise<StageMarkerHost | null> => {
  for (const host of STAGE_MARKER_HOSTS) {
    const m = await liveMarkerFor($, directory, tasksDir, host, now)
    if (m?.taskId === taskId) return host
  }
  return null
}

/** One host's LIVE stage marker, as much of it as a status line needs. */
export interface LiveStageMarker {
  readonly host: StageMarkerHost
  readonly taskId: string | null
  readonly stage: string
  readonly kind: string
  /** Wall-clock ms deadline of the stage attempt — display-only, like the marker's own. */
  readonly deadline: number
  readonly pid?: number
}

/**
 * Read one host's marker and judge it live — the SAME rule
 * `taskDrivenByStageMarker` applies (deadline in the future, and a carried pid
 * must still exist), factored so the two readers cannot drift. Null for a
 * missing, garbled, expired, or dead-writer marker.
 */
const liveMarkerFor = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  host: StageMarkerHost,
  now: number,
): Promise<LiveStageMarker | null> => {
  const out = await $`cat ${hostStageMarkerPath(directory, tasksDir, host)}`.quiet().nothrow()
  if (out.exitCode !== 0) return null
  try {
    const m = JSON.parse(out.stdout.toString()) as Record<string, unknown>
    if (typeof m["deadline"] !== "number" || m["deadline"] <= now) return null // stage window over — dead either way
    // Shared with the claim stamp's writer probe (`liveness.ts`) so the two
    // oracles cannot drift; see there for the EPERM caveat.
    const pid = m["pid"]
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      if (!(await pidAlive($, pid))) return null
    }
    return {
      host,
      taskId: typeof m["taskId"] === "string" ? m["taskId"] : null,
      stage: typeof m["stage"] === "string" ? m["stage"] : "unknown",
      kind: typeof m["kind"] === "string" ? m["kind"] : "engineering",
      deadline: m["deadline"],
      ...(typeof pid === "number" ? { pid } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Every host's LIVE stage marker — the cross-process "a loop is at <stage> on
 * <task> right now" witness, for `status`. Before this, status on both hosts
 * answered from its own process alone (`getWorkflow` / the in-memory `active`),
 * so a watch worker in another terminal driving task X read as "no active
 * loop" here — inviting a competing `claim X` that then bounced off refusals
 * status never foreshadowed. Callers that should not report THEMSELVES filter
 * by their own pid. Best-effort like every marker read.
 */
export const liveStageMarkers = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  now: number = Date.now(),
): Promise<LiveStageMarker[]> => {
  const live: LiveStageMarker[] = []
  for (const host of STAGE_MARKER_HOSTS) {
    const m = await liveMarkerFor($, directory, tasksDir, host, now)
    if (m) live.push(m)
  }
  return live
}
