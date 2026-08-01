import path from "node:path"
import type { Shell } from "../host.js"
import { writeFileAtomic } from "../fsatomic.js"
import { isSafeTaskId } from "./schema.js"
import type { Task } from "./schema.js"

/**
 * Plan-request markers: "plan THIS queued task next".
 *
 * A marker lives at `<tasksDir>/queued/.requests/<id>`, alongside the `.claims/`
 * markers of the same folder, and it is deliberately the weaker of the two. A
 * claim marker asserts a LIVE loop and every gate verb refuses on it; a request
 * asserts only that a human asked for this task first. Nothing waits on it,
 * nothing is blocked by it, and a stale one is inert — the worst a wrong request
 * can do is reorder one claim walk.
 *
 * That is why it is NOT folded into `claim-marker.ts`: no exclusion is needed
 * (two requests for one id are the same request), so there is no mkdir trick and
 * no staleness window here. `writeFileAtomic` is enough — a reader sees the old
 * marker or the new one, never a torn stamp.
 *
 * It is also never committed. The backlog is git-ignored by default
 * (`ignoreBacklog`), and even where it isn't, a request is ephemeral
 * coordination state like a claim marker rather than a lifecycle fact worth a
 * commit. The hub's route writes one and commits nothing; that is the whole
 * reason it can write one without being a driver.
 */

/** The pool a plan request is read from. Only engineering's planless pool has one today. */
const REQUESTS_STATUS = "queued"

/** The marker directory for a status folder's plan requests. Pure. */
export const requestsDir = (directory: string, tasksDir: string, status: string = REQUESTS_STATUS): string =>
  path.join(directory, tasksDir, status, ".requests")

/** One task's plan-request marker path. Pure — callers must screen `id` first. */
export const planRequestPath = (directory: string, tasksDir: string, id: string, status: string = REQUESTS_STATUS): string =>
  path.join(requestsDir(directory, tasksDir, status), id)

/** A plan request as read back. `requestedAt`/`by` are absent when the stamp was unreadable. */
export interface PlanRequest {
  readonly id: string
  readonly requestedAt?: string
  readonly by?: string
}

/**
 * Ask for `id` to be planned before the rest of the queued pool. Idempotent — a
 * second request just restamps. False when the id is unsafe or the write failed;
 * never throws.
 */
export const requestPlan = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  id: string,
  opts: { readonly by?: string | null; readonly now?: Date } = {},
): Promise<boolean> => {
  if (!isSafeTaskId(id)) return false
  const dir = requestsDir(directory, tasksDir)
  await $`mkdir -p ${dir}`.quiet().nothrow()
  const stamp = JSON.stringify({
    requestedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.by ? { by: opts.by } : {}),
    source: "hub",
  })
  const wrote = await writeFileAtomic($, path.join(dir, id), stamp)
  return wrote.exitCode === 0
}

/**
 * Withdraw `id`'s request. True when a marker was there to remove, false when
 * there was nothing (or the id is unsafe) — idempotent, never throws.
 */
export const revokePlanRequest = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  id: string,
  status: string = REQUESTS_STATUS,
): Promise<boolean> => {
  if (!isSafeTaskId(id)) return false
  const file = planRequestPath(directory, tasksDir, id, status)
  const present = await $`test -f ${file}`.quiet().nothrow()
  if (present.exitCode !== 0) return false
  await $`rm -f ${file}`.quiet().nothrow()
  return true
}

/**
 * Drop `id`'s request because a claim HONOURED it. Identical to a revoke —
 * separately named so the claim walk reads as "spend the hint", not "cancel it".
 */
export const consumePlanRequest = revokePlanRequest

/** Ids carrying a plan request. `[]` when the directory is absent — the normal case. */
export const listPlanRequestIds = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  status: string = REQUESTS_STATUS,
): Promise<string[]> => {
  const out = await $`ls -1 ${requestsDir(directory, tasksDir, status)}`.quiet().nothrow()
  if (out.exitCode !== 0) return []
  return out.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    // Screened on the way OUT as well as in: the directory is a plain folder a
    // human can drop anything into, and these ids are joined back into paths.
    .filter((s) => s.length > 0 && isSafeTaskId(s))
}

/**
 * Requests with their stamps, for display. An unreadable or garbled stamp yields
 * `{ id }` alone — a request with no time beats a request with a wrong one.
 */
export const listPlanRequests = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  status: string = REQUESTS_STATUS,
): Promise<PlanRequest[]> => {
  const ids = await listPlanRequestIds($, directory, tasksDir, status)
  const requests: PlanRequest[] = []
  for (const id of ids) {
    const out = await $`cat ${planRequestPath(directory, tasksDir, id, status)}`.quiet().nothrow()
    if (out.exitCode !== 0) {
      requests.push({ id })
      continue
    }
    try {
      const { requestedAt, by } = JSON.parse(out.stdout.toString()) as { requestedAt?: unknown; by?: unknown }
      requests.push({
        id,
        ...(typeof requestedAt === "string" ? { requestedAt } : {}),
        ...(typeof by === "string" ? { by } : {}),
      })
    } catch {
      requests.push({ id })
    }
  }
  return requests
}

/**
 * Requests whose task no longer sits in the pool — inert, but they would sit
 * there reordering nothing. Reported by `doctor`, removed by `doctor fix`, and
 * the single predicate all three hosts' doctors ask so they cannot disagree.
 *
 * `presentIds` is the caller's listing of that folder. Pass one it has
 * CONFIRMED: a listing that lags the real filesystem would name a live request
 * as a stray.
 */
export const strayPlanRequestIds = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  presentIds: readonly string[],
  status: string = REQUESTS_STATUS,
): Promise<string[]> => {
  const present = new Set(presentIds)
  return (await listPlanRequestIds($, directory, tasksDir, status)).filter((id) => !present.has(id))
}

/**
 * Drop exactly `strayIds` and return the ids actually revoked. `strayIds` must
 * be ids the caller CONFIRMED stray against the real filesystem (see
 * `confirmedStrayPlanRequestIds` in `store.ts`). This deliberately re-lists
 * nothing: the shape it replaces re-listed `.requests/` at delete time, so a
 * request written after the caller's confirmation pass was judged only against
 * a lagging listing — and a human's fresh ask was silently deleted.
 */
export const revokeStrayPlanRequests = async (
  $: Shell,
  directory: string,
  tasksDir: string,
  strayIds: readonly string[],
  status: string = REQUESTS_STATUS,
): Promise<string[]> => {
  const swept: string[] = []
  for (const id of strayIds) {
    if (await revokePlanRequest($, directory, tasksDir, id, status)) swept.push(id)
  }
  return swept
}

/**
 * Withdraw `id`'s request in the status folder at `statusDir` — for movers
 * that hold only the task file's folder, not `directory`/`tasksDir`.
 * Best-effort and silent: a mover must never fail on marker cleanup.
 */
export const revokePlanRequestAt = async ($: Shell, statusDir: string, id: string): Promise<void> => {
  if (!isSafeTaskId(id)) return
  await $`rm -f ${path.join(statusDir, ".requests", id)}`.quiet().nothrow()
}

/**
 * Requested candidates first, each group's existing order preserved. Pure.
 *
 * A stable partition rather than a sort: the input arrives in `selectOrder`
 * (priority number, then id), and that has to keep deciding BOTH which requested
 * task goes first and how the unrequested tail is walked. A comparator keyed on
 * requestedness alone would reshuffle ties on some engines.
 */
export const requestedFirst = (candidates: readonly Task[], requested: ReadonlySet<string>): Task[] => {
  if (requested.size === 0) return [...candidates]
  const first: Task[] = []
  const rest: Task[] = []
  for (const task of candidates) (requested.has(task.id) ? first : rest).push(task)
  return [...first, ...rest]
}
