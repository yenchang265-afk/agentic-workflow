import { extractPlan, extractRunBase, extractRunBranch, extractRunDiffstat, extractRunSuggestions, findByIdIn, listByStatus, listClaimIds, STATUSES } from "@agentic-workflow/core/task/store"
import { defaultBranchName, diffText } from "@agentic-workflow/core/workflow/git"
import { DEFAULT_MAX_DIFF_LINES } from "@agentic-workflow/core/source/pr-shared"
import type { Config } from "@agentic-workflow/core/workflow/state"
import { parseRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { ReviewDiffResponse, ReviewItem, ReviewResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { badRequest, isSafeId, json, notFound, ok, type JsonResponse, type ParsedRequest } from "../http.js"
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
          // Both read off the done note the run already wrote — no extra IO.
          // Null everywhere but a completed run's in-review park, and the UI
          // simply omits the line.
          branch: extractRunBranch(task) ?? null,
          diffstat: extractRunDiffstat(task) ?? null,
          // The suggestions note precedes the done note, so `lastEvent` (the
          // trail's newest line) never showed it — the one note written FOR
          // this gate was the one the gate could not see.
          suggestions: extractRunSuggestions(task) ?? null,
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

/**
 * `workflows.<kind>.maxDiffLines`, else the reviewer-role default. The knob
 * was declared for the review sitter; the human's own review has the same
 * reason to be bounded, and one number is better than two.
 */
const diffLimitFor = (config: Config, kind: string): number => {
  const knob = (config.workflows?.[kind] as { readonly maxDiffLines?: unknown } | undefined)?.maxDiffLines
  return typeof knob === "number" && Number.isInteger(knob) && knob > 0 ? knob : DEFAULT_MAX_DIFF_LINES
}

/**
 * GET /api/review/:status/:id/diff — the diff behind a ship decision (design
 * 58). Designs 33/34 gave the CLI ship gate a verified diff view and the
 * reviewer's suggestions; the hub's ship button approved a diff it had only
 * ever shown the SIZE of. The branch and base come off the done note the run
 * wrote — the same fields the ship gate pushes — never from the request, so
 * this route cannot be pointed at an arbitrary ref pair; the base falls back to
 * the repo's default branch exactly as the ship does. Read-only, and rendered
 * on demand rather than on the queue listing, because a diff is unbounded and
 * the queue is fetched on every SSE tick.
 */
export const getReviewDiff = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const status = req.params["status"] ?? ""
  const id = req.params["id"] ?? ""
  if (!isSafeId(id)) return badRequest(`invalid task id "${id}"`)
  const known = new Set<string>([...deps.boards.flatMap((b) => b.statuses), ...STATUSES])
  if (!known.has(status)) return badRequest(`unknown status "${status}"`)
  const task = await findByIdIn(deps.sh, deps.directory, deps.tasksDir, status, id, deps.log)
  if (!task) return notFound(`task ${status}/${id}`)
  const branch = extractRunBranch(task)
  if (!branch) return json(409, { error: `"${id}" has no completed run on record — nothing to diff (the done note names the branch).` })
  const base = extractRunBase(task) ?? (await defaultBranchName(deps.sh, deps.directory))
  if (!base) return json(409, { error: `"${id}": the run recorded no base and the repo's default branch could not be resolved.` })
  const kind = deps.boards.find((b) => b.statuses.includes(status))?.kind ?? "engineering"
  const maxLines = diffLimitFor(deps.config, kind)
  const diff = await diffText(deps.sh, deps.directory, base, branch, maxLines)
  const diffCmd = `git diff ${base}...${branch}`
  if (!diff) return json(409, { error: `\`${diffCmd}\` is empty or its refs are gone — the branch may have been deleted or merged.` })
  const response: ReviewDiffResponse = { branch, base, diffCmd, ...diff, maxLines }
  return ok(response)
}
