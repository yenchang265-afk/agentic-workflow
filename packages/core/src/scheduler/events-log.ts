import path from "node:path"
import { z } from "zod"
import type { Shell } from "../host.js"

/**
 * Append-only scheduler diagnostics: `<tasksDir>/runs/events.jsonl`, one JSON
 * object per line. This is the history the point-in-time state files (claim
 * markers, watch lease, stage markers) cannot give: what the scheduler DID —
 * claims won, why polls skipped, stale claims and leases taken over. Without
 * it, "the watcher polled all night and claimed nothing — why?" has no answer
 * on disk.
 *
 * Polarity: the parser is fail-OPEN per line (a torn or unparseable line is
 * dropped, the rest survive) — the opposite of the metrics sidecar's
 * fail-closed document parse, deliberately: this is a diagnostics feed, and a
 * bad line must not take the whole history down. Writers are best-effort and
 * never fail the loop, matching `appendRunLog`.
 *
 * Flood control is the WRITER's job: skip events fire on every empty poll, so
 * callers dedupe with `skipSetKey` and append only when the skip-set changes
 * (see the drivers). Heartbeats are never logged. Rotation keeps the file
 * bounded: past ~256 KB it is renamed to `events.1.jsonl` (overwriting the
 * previous generation), so the total footprint stays ~512 KB.
 *
 * The file is machine state, not review material — consuming repos should
 * gitignore `runs/events*.jsonl` alongside `runs/*.state.json`.
 */

const SchedulerEventBaseSchema = z.object({
  /** ISO timestamp the writer stamped. */
  at: z.string(),
  /** Which host process wrote it (opencode / claude / qwen). */
  host: z.string(),
  pid: z.number().int(),
})

const SkipReasonSchema = z.object({ message: z.string(), actionable: z.boolean() })

export const SchedulerEventSchema = z.discriminatedUnion("type", [
  SchedulerEventBaseSchema.extend({ type: z.literal("claim"), kind: z.string(), id: z.string() }),
  SchedulerEventBaseSchema.extend({ type: z.literal("skip"), reasons: z.array(SkipReasonSchema) }),
  SchedulerEventBaseSchema.extend({ type: z.literal("release"), kind: z.string(), id: z.string() }),
  SchedulerEventBaseSchema.extend({
    type: z.literal("terminal"),
    kind: z.string(),
    id: z.string(),
    outcome: z.string(),
    retryable: z.boolean().optional(),
  }),
  /** A stale claim marker was renamed aside and released — otherwise invisible. */
  SchedulerEventBaseSchema.extend({ type: z.literal("claim-takeover"), id: z.string(), ageMinutes: z.number().optional() }),
  /** A dead watcher's lease was taken over. */
  SchedulerEventBaseSchema.extend({
    type: z.literal("lease-takeover"),
    oldPid: z.number().int().optional(),
    oldHost: z.string().optional(),
  }),
])

export type SchedulerEvent = z.infer<typeof SchedulerEventSchema>

export const eventsLogPath = (directory: string, tasksDir: string): string =>
  path.join(directory, tasksDir, "runs", "events.jsonl")

/** The rotated previous generation's path. */
export const eventsLogRotatedPath = (directory: string, tasksDir: string): string =>
  path.join(directory, tasksDir, "runs", "events.1.jsonl")

/** Rotate once the live file passes this. Two generations bound the footprint at ~2×. */
export const EVENTS_LOG_ROTATE_BYTES = 256 * 1024

/** One event as its NDJSON line (no trailing newline). Pure. */
export const formatEventLine = (event: SchedulerEvent): string => JSON.stringify(event)

/**
 * Parse a log's raw content, dropping unparseable lines (fail-open — see the
 * module doc). Pure.
 */
export const parseEventsLog = (raw: string): SchedulerEvent[] => {
  const events: SchedulerEvent[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = SchedulerEventSchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) events.push(parsed.data)
    } catch {
      // torn or foreign line — skip
    }
  }
  return events
}

/**
 * Dedup key for a poll's skip-set: writers keep the last-written key in memory
 * and append a `skip` event only when it changes (never for an empty set). Pure.
 */
export const skipSetKey = (reasons: readonly { message: string; actionable: boolean }[]): string =>
  reasons
    .map((r) => `${r.actionable ? "!" : ""}${r.message}`)
    .sort()
    .join("\n")

/**
 * Whether the live file should rotate before the next append, given its size
 * (`null` = absent). Split from the IO so the threshold is testable. Pure.
 */
export const shouldRotate = (sizeBytes: number | null): boolean =>
  sizeBytes !== null && sizeBytes > EVENTS_LOG_ROTATE_BYTES

/**
 * Append events to the log, rotating first when the live file is past the
 * threshold. Best-effort: telemetry never fails the loop, so every step is
 * `.nothrow()` and errors are swallowed. Concurrent appends from two hosts are
 * line-atomic in practice (O_APPEND, small lines) and the parser tolerates a
 * torn line regardless.
 */
export const appendSchedulerEvents = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  events: readonly SchedulerEvent[],
): Promise<void> => {
  if (events.length === 0) return
  const file = eventsLogPath(directory, tasksDir)
  await $`mkdir -p ${path.dirname(file)}`.quiet().nothrow()
  const stat = await $`wc -c < ${file}`.quiet().nothrow()
  const size = stat.exitCode === 0 ? Number(stat.stdout.toString().trim()) : null
  if (shouldRotate(Number.isFinite(size as number) ? size : null)) {
    await $`mv ${file} ${eventsLogRotatedPath(directory, tasksDir)}`.quiet().nothrow()
  }
  const lines = events.map(formatEventLine).join("\n")
  await $`printf '%s\n' ${lines} >> ${file}`.quiet().nothrow()
}
