import type { Shell } from "../host.js"
import {
  claimTask,
  claimTaskSweepingDeadWriter,
  claimTaskSweepingStale,
  claimWriterState,
  STALE_CLAIM_MINUTES,
} from "../task/store.js"
import { taskDrivenByStageMarker, taskNamedByStageMarker } from "./stage-marker.js"

/** What the claim helpers need to locate a task's marker (store.ts keeps its own private copy). */
type FileRef = { readonly id: string; readonly path: string }

/**
 * Claiming a task for a HUMAN-invoked verb that resumes or redirects a run that
 * already stopped — `recover` and `waive`.
 *
 * This is a fail-CLOSED judgement, and it is the one place it lives. A false
 * "the holder is dead" sweeps a live claim and starts a second drive on one
 * `feature/<id>` branch, so every arm below has to be earned. It was written
 * twice (once per host) and then a third caller copied the WRONG shape from it —
 * `claimTaskSweepingStale(task, 0)` with no evidence at all, which would delete
 * a rival's brand-new claim — which is exactly why the rule now has a single
 * implementation the callers cannot paraphrase.
 *
 * The order, strongest witness first:
 *
 * 1. An uncontested claim (no marker held) — nothing to judge.
 * 2. A LIVE stage marker naming the task ⇒ refuse. Another process is mid-stage.
 * 3. A DEAD stage marker naming the task ⇒ immediate takeover. A run reached a
 *    stage and its writer died; the evidence is the marker, so the zero-window
 *    sweep is the right one here.
 * 4. No marker, but the claim stamp names a pid on this machine that is gone ⇒
 *    immediate takeover via the IDENTITY-judged sweep, never
 *    `…Stale(task, 0)`: a zero age window degrades the rename-aside's re-judge
 *    to a bare existence test, and a rival that claimed in between stamps its
 *    own live pid, so only identity re-judges soundly.
 * 5. Anything else ⇒ the wall-clock window. A just-claimed LIVE run spends
 *    minutes in its setup window (isolation, `worktreeSetup`/`npm ci`, check
 *    discovery) before its first marker write, and sweeping there is the second
 *    drive this whole function exists to prevent.
 *
 * A refusal never leaves a marker behind: the arms that could take one only run
 * once the evidence authorizes it. `verb` and `doctorHint` are the callers' only
 * inputs to the prose, because the message has to name the verb the human just
 * typed and that host's own doctor command.
 */
export const claimForTakeover = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  task: FileRef,
  opts: { readonly verb: string; readonly doctorHint: string },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (await claimTask($, task)) return { ok: true }
  // A held marker no longer means "leftover from the dead run" — graceful stops
  // release it — so a failed claim is either a live loop in another process or a
  // crash whose marker outlived it.
  const liveHost = await taskDrivenByStageMarker($, directory, tasksDir, task.id)
  if (liveHost) {
    return {
      ok: false,
      message: `Task "${task.id}" is being driven by a live ${liveHost} loop (fresh stage marker) — stop that loop first, or wait out its stage deadline.`,
    }
  }
  const namedByMarker = await taskNamedByStageMarker($, directory, tasksDir, task.id)
  // Skipped when the marker already settled it — the probe costs subprocesses.
  const writer = namedByMarker ? "unknown" : await claimWriterState($, task)
  const took = namedByMarker
    ? await claimTaskSweepingStale($, task, 0)
    : writer === "dead"
      ? await claimTaskSweepingDeadWriter($, task)
      : await claimTaskSweepingStale($, task, STALE_CLAIM_MINUTES)
  if (took) return { ok: true }
  return {
    ok: false,
    message:
      namedByMarker || writer === "dead"
        ? `Task "${task.id}"'s claim marker was just re-taken by another process — nothing to ${opts.verb}.`
        : writer === "alive"
          ? `Task "${task.id}"'s claim is held by a live process on this machine that has not written a stage marker yet — ` +
            `it is probably still setting up (isolation, dependency install). Stop that run, or retry once its claim goes stale ` +
            `(${STALE_CLAIM_MINUTES} minutes).`
          : `Task "${task.id}"'s claim is less than ${STALE_CLAIM_MINUTES} minutes old, no stage marker exists yet, and its holder ` +
            `cannot be identified on this machine — the claiming run may still be setting up before its first stage. ` +
            `If you know it is gone, ${opts.doctorHint}; otherwise retry once the claim goes stale.`,
  }
}
