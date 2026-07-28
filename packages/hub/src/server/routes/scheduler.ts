import { parseEventsLog } from "@agentic-workflow/core/scheduler/events-log"
import type { SchedulerEventsResponse, SchedulerEventView } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { readText } from "../io.js"
import { ok, type JsonResponse } from "../http.js"

/**
 * The scheduler event feed: `runs/events.jsonl` (+ its rotated previous
 * generation), parsed fail-open by core and tail-capped here. This is the
 * monitor's answer to "the watcher ran all night — what did it DO?": claims,
 * deduped skip-sets, releases, terminals, and the stale claim/lease takeovers
 * that are invisible in every point-in-time state file.
 */

const TAIL = 200

export const getSchedulerEvents = async (deps: HubDeps): Promise<JsonResponse> => {
  // Rotated generation first so the concatenation is chronological.
  const parts = await Promise.all([
    readText(deps, `${deps.tasksDir}/runs/events.1.jsonl`),
    readText(deps, `${deps.tasksDir}/runs/events.jsonl`),
  ])
  const events = parts.filter((p): p is string => p !== null).flatMap(parseEventsLog)
  const tail: SchedulerEventView[] = events.slice(-TAIL).reverse()
  const response: SchedulerEventsResponse = { events: tail }
  return ok(response)
}
