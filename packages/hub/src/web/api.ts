/** Minimal typed fetch client for the hub API. */

const parse = async <T>(res: Response): Promise<T> => {
  const body: unknown = await res.json()
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : res.statusText
    throw new Error(message)
  }
  return body as T
}

export const fetchJson = async <T>(path: string): Promise<T> => parse(await fetch(path))

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Hub-Client": "1" },
    body: JSON.stringify(body),
  })

/** POST with the mutating-route header (the hub's CSRF token-of-intent). */
export const postJson = async <T>(path: string, body: unknown): Promise<T> => parse(await post(path, body))

/**
 * POST an action whose *refusal is data, not an error*. Core's gate answers a
 * well-formed request with `{ ok: false, message, variant }` — "it's in queued,
 * not draft" is a domain outcome the UI renders, and the route returns it with a
 * 200. `postJson` would be wrong here only if the route 4xx'd, but the
 * distinction matters the other way: this helper never throws on a 200, so an
 * `ok: false` body reaches the caller intact instead of collapsing into an
 * `Error` that loses `variant`.
 *
 * Genuine transport/validation failures (400, 409, 500) still throw.
 */
export const postAction = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await post(path, body)
  const parsed: unknown = await res.json()
  if (!res.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed ? String(parsed.error) : res.statusText
    throw new Error(message)
  }
  return parsed as T
}
