import { useCallback, useEffect, useState, type DependencyList } from "react"
import { fetchJson } from "./api.js"

/**
 * Fetch JSON into component state, re-running when `deps` change.
 *
 * Replaces the old `useJson`, keeping both of its hard-won guarantees:
 *
 *  - the error is cleared at the start of every fetch, so a transient failure
 *    can't wedge a panel until remount (a later success recovers it);
 *  - a response whose `deps` changed before it resolved is dropped, so
 *    out-of-order responses from rapid repo/run/kind switching can't paint
 *    stale data (no AbortController — the fetch still completes, its result is
 *    ignored).
 *
 * and adding the three things every caller was working around:
 *
 *  - **`loading`.** `data === null` used to mean "fetching", "never fetched"
 *    and "failed" all at once, so panels could only render a grey sentence that
 *    collapsed the whole region.
 *  - **`refetch`.** Twelve error sites had no recovery but a page reload.
 *  - **dedupe + a shared cache.** `/api/active` was fetched three times
 *    concurrently — by Board, ActivePanel and PrKindPanel — on every `active`
 *    event. Concurrent callers of the same URL now join one request, and a URL
 *    already fetched paints from cache while it revalidates instead of
 *    flashing a placeholder.
 */

/** Last successful body per URL. Paints instantly; always revalidated. */
const cache = new Map<string, unknown>()
/** In-flight request per URL, so concurrent callers share one round trip. */
const inflight = new Map<string, Promise<unknown>>()

const load = <T>(path: string): Promise<T> => {
  const existing = inflight.get(path)
  if (existing) return existing as Promise<T>

  const settle = (): void => {
    // Only clear the slot if it is still ours — a refetch may have replaced it.
    if (inflight.get(path) === run) inflight.delete(path)
  }
  const run: Promise<T> = fetchJson<T>(path).then(
    (data) => {
      cache.set(path, data)
      settle()
      return data
    },
    (err: unknown) => {
      settle()
      throw err
    },
  )
  inflight.set(path, run)
  return run
}

export interface Resource<T> {
  readonly data: T | null
  readonly error: string | null
  /** Fetching with nothing to paint meanwhile — the only true empty state. */
  readonly loading: boolean
  /** Painting a cached body while a revalidation is in flight. */
  readonly stale: boolean
  /** Re-run the request now. Always hits the network; joins one already in flight. */
  readonly refetch: () => void
}

export const useResource = <T>(path: string, deps: DependencyList): Resource<T> => {
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<T | null>(() => (cache.get(path) as T | undefined) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(true)

  useEffect(() => {
    let ignore = false
    // Seed from cache so a revalidation doesn't blank the region; a URL never
    // fetched still starts null, which is what `loading` reports.
    setData((cache.get(path) as T | undefined) ?? null)
    setError(null)
    setPending(true)
    load<T>(path)
      .then((fresh) => {
        if (ignore) return
        setData(fresh)
        setPending(false)
      })
      .catch((e: Error) => {
        if (ignore) return
        setError(e.message)
        setPending(false)
      })
    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, path, attempt])

  const refetch = useCallback(() => setAttempt((n) => n + 1), [])

  return { data, error, loading: pending && data === null, stale: pending && data !== null, refetch }
}
