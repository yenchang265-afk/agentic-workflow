/**
 * Hash routing for the hub SPA.
 *
 * Until now no view in this app had an address. The active tab, the selected
 * run, the open task and the chosen workflow kind all lived in `useState`, so
 * nothing could be linked or bookmarked, Back exited the app entirely, and
 * switching tabs unmounted the old one and destroyed whatever was in it.
 *
 * Hash rather than the History API, deliberately: `safeStaticPath` in
 * server/http.ts maps a URL path to a file under dist/web and 404s otherwise,
 * on purpose — it is the traversal and DNS-rebinding rail. Real paths would
 * need an SPA fallback punched through it, which is a security-adjacent server
 * change to buy a prettier URL on a localhost tool. The hash never reaches the
 * server at all.
 *
 * No router dependency either: six screens, no nested layouts, and a dependency
 * is permanent.
 *
 * Parsing and building are pure and live at the top of this file so the routing
 * table is testable without a DOM.
 */

export const SCREENS = ["monitor", "creator", "metrics", "config"] as const
export type Screen = (typeof SCREENS)[number]

export const DEFAULT_SCREEN: Screen = "monitor"

export interface Route {
  readonly screen: Screen
  /** Path segments after the screen, already percent-decoded. */
  readonly params: readonly string[]
  /** Query pairs after `?`, already percent-decoded. */
  readonly query: Readonly<Record<string, string>>
}

const isScreen = (s: string): s is Screen => (SCREENS as readonly string[]).includes(s)

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    // A stray `%` in a hand-edited URL must not take the whole app down.
    return s
  }
}

/**
 * Read a location hash into a route. Total: anything unrecognized — an empty
 * hash, a typo, a link from an older build — resolves to the default screen
 * rather than a blank page.
 */
export const parseHash = (hash: string): Route => {
  const raw = hash.replace(/^#/, "").replace(/^\//, "")
  const [pathPart = "", queryPart = ""] = raw.split("?", 2)
  const segments = pathPart.split("/").filter(Boolean).map(decode)
  const [first, ...params] = segments

  const query: Record<string, string> = {}
  for (const pair of queryPart.split("&")) {
    if (!pair) continue
    const [k = "", ...rest] = pair.split("=")
    if (k) query[decode(k)] = decode(rest.join("="))
  }

  return first !== undefined && isScreen(first)
    ? { screen: first, params, query }
    : { screen: DEFAULT_SCREEN, params: [], query }
}

/** Build a location hash from a route. `buildHash(parseHash(h))` is stable. */
export const buildHash = (route: {
  screen: Screen
  params?: readonly string[]
  query?: Readonly<Record<string, string | undefined>>
}): string => {
  const path = [route.screen, ...(route.params ?? [])].map(encodeURIComponent).join("/")
  const pairs = Object.entries(route.query ?? {})
    // An undefined value means "drop this key" — it is how a caller clears the
    // open drawer or the selected run without rebuilding the whole query.
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return `#/${path}${pairs.length > 0 ? `?${pairs.join("&")}` : ""}`
}

/** The same route with `patch` merged over its query; `undefined` drops a key. */
export const withQuery = (route: Route, patch: Readonly<Record<string, string | undefined>>): string =>
  buildHash({ screen: route.screen, params: route.params, query: { ...route.query, ...patch } })
