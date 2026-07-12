import { useEffect, useState, type DependencyList } from "react"
import { fetchJson } from "./api.js"

/**
 * Fetch JSON into component state, re-running when `deps` change. Two guarantees
 * the hand-rolled `fetchJson(...).then(setData)` effects lacked:
 *
 *  - the error is cleared at the start of every fetch, so a transient failure
 *    can't wedge a panel until remount (a later success recovers it);
 *  - a response whose `deps` changed before it resolved is dropped, so
 *    out-of-order responses from rapid repo/run/kind switching can't paint stale
 *    data (no AbortController — the fetch still completes, its result is ignored).
 *
 * `data` is intentionally kept across refetches so an SSE-driven refresh doesn't
 * flash a loading placeholder; callers that ignore `error` just don't read it.
 */
export const useJson = <T>(path: string, deps: DependencyList): { data: T | null; error: string | null } => {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let ignore = false
    setError(null)
    fetchJson<T>(path)
      .then((d) => {
        if (!ignore) setData(d)
      })
      .catch((e: Error) => {
        if (!ignore) setError(e.message)
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}
