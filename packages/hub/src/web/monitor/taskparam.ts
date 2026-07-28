import { STATUSES, type TaskStatus } from "@agentic-workflow/core/task/statuses"

/**
 * Read the drawer's `?task=<status>/<id>` URL parameter.
 *
 * Two things this is careful about, because the param is now user-editable and
 * shareable rather than internal state:
 *
 *  - the status is checked against the real vocabulary instead of cast, so a
 *    typo (or an old link) opens nothing rather than firing a request for a
 *    folder that doesn't exist;
 *  - the id is everything after the FIRST slash, not the second segment of a
 *    two-way split — silently truncating an id at a slash would open a
 *    different task than the link named, which is worse than opening none.
 *
 * `statuses.ts` is core's dependency-light leaf module, so importing it here
 * costs the web bundle nothing beyond the string list.
 */

const isStatus = (s: string): s is TaskStatus => (STATUSES as readonly string[]).includes(s)

export const parseTaskParam = (param: string | undefined): { status: TaskStatus; id: string } | null => {
  if (!param) return null
  const slash = param.indexOf("/")
  if (slash <= 0) return null
  const status = param.slice(0, slash)
  const id = param.slice(slash + 1)
  return isStatus(status) && id !== "" ? { status, id } : null
}

/**
 * The inverse — the param naming a task, for building a link to its drawer.
 *
 * Takes a plain string because a board's columns come from its manifest, not
 * from this union. Liberal here, strict in `parseTaskParam`: a kind that
 * declared a status outside core's vocabulary simply won't reopen from a URL,
 * which is a visible no-op rather than the cast-and-hope the drawer used to do.
 */
export const taskParam = (status: string, id: string): string => `${status}/${id}`
