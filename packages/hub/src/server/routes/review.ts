import { extractPlan, listByStatus, listClaimIds } from "@agentic-workflow/core/task/store"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { ReviewItem, ReviewResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { ok, type JsonResponse } from "../http.js"
import { readText } from "../io.js"
import { extractAuditNotes } from "../notes.js"
import { byWaiting, noteTimestamps, planExcerpt, runContext } from "../review.js"
import { toCard } from "./backlog.js"

/**
 * The review queue: every task waiting on a human, across every backlog kind
 * this repo has enabled, with the evidence a gate decision needs.
 *
 * It exists as its own route rather than as a filter over `/api/backlog`
 * because of what it carries. Age, plan excerpt and last-run context are
 * exactly what a decision needs and what a board card never had — but the run
 * context costs a file read per task, which is fine for the handful of tasks
 * sitting at a gate and is not fine for every task in every column of every
 * board. Scoping the expensive fields to the population that needs them is the
 * whole reason this is a separate endpoint.
 *
 * Gate columns come from each manifest via `deps.boards` (`gateStatuses`), not
 * from a hardcoded list — a kind that parks somewhere else is picked up for
 * free.
 */

import { isEpicType } from "@agentic-workflow/core/task/schema"

/** Tracking epics order their child slices; core refuses to plan one, so it is not a decision. */
const isDecidable = (type: string | undefined): boolean => !isEpicType(type)

export const getReview = async (deps: HubDeps): Promise<JsonResponse> => {
  const backlogKinds = deps.boards.filter((b) => b.sourceType === "backlog")

  // Claims are per pool, and a claimed task is one a loop is driving — the hub
  // refuses to gate it, so the queue has to say so rather than offer a button
  // that will be refused.
  const claimed = new Set(
    (
      await Promise.all(
        [...new Set(backlogKinds.flatMap((b) => b.pools))].map((status) =>
          listClaimIds(deps.sh, deps.directory, deps.tasksDir, status),
        ),
      )
    ).flat(),
  )

  const items: ReviewItem[] = []
  for (const board of backlogKinds) {
    for (const status of board.gateStatuses) {
      const tasks = await listByStatus(deps.client, deps.directory, deps.tasksDir, status, deps.log)
      for (const task of tasks) {
        if (!isDecidable(task.type)) continue
        // The body is already in hand from the listing, so the trail and the
        // plan excerpt cost nothing beyond parsing.
        const stamps = noteTimestamps(extractAuditNotes(task.body))
        // A run's id is its task's id; a task that has never run has no log,
        // and an unreadable one is simply no context, never an error.
        const log = await readText(deps, `${deps.tasksDir}/runs/${task.id}.md`)
        items.push({
          kind: board.kind,
          status,
          card: toCard(task),
          ...stamps,
          planExcerpt: planExcerpt(extractPlan(task)),
          lastRun: log === null ? null : runContext(task.id, parseRunLog(log)),
          claimed: claimed.has(task.id),
        })
      }
    }
  }

  const response: ReviewResponse = {
    items: items.sort(byWaiting),
    kinds: backlogKinds.map((b) => b.kind),
  }
  return ok(response)
}
