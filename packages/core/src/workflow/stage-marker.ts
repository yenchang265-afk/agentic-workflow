import path from "node:path"
import { writeFileAtomic } from "../fsatomic.js"
import type { Shell } from "../host.js"
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
}

/** Absolute path of the OpenCode host's stage marker. Pure. */
export const opencodeMarkerPath = (directory: string, tasksDir: string): string =>
  hostStageMarkerPath(directory, tasksDir, "opencode")

/** Build the marker for a stage the driver is about to fire. Pure. */
export const opencodeStageMarker = (state: WorkflowState, deadline: number | null): OpencodeStageMarker => ({
  host: "opencode",
  kind: state.kind ?? "engineering",
  stage: state.stage,
  taskId: state.task?.id ?? null,
  worktree: state.git?.worktree ?? null,
  deadline,
  iteration: state.iteration,
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
