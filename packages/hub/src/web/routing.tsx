import { useMemo, useSyncExternalStore, type ReactNode } from "react"
import { parseHash, type Route } from "./route.js"

/**
 * The DOM half of routing — kept out of route.ts so the routing table itself
 * stays pure and testable in a package with no DOM harness.
 */

const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of listeners) listener()
}

const subscribe = (onChange: () => void): (() => void) => {
  if (listeners.size === 0) window.addEventListener("hashchange", emit)
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0) window.removeEventListener("hashchange", emit)
  }
}

const snapshot = (): string => window.location.hash

export const useRoute = (): Route => {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "#/")
  // Memoized on the raw hash so the returned Route is referentially stable
  // across unrelated re-renders — a fresh object per call made every effect
  // keyed on `route` fire on every render of its component.
  return useMemo(() => parseHash(hash), [hash])
}

/**
 * Go to a hash. `replace` rewrites the current entry instead of pushing one —
 * used for corrections the user never chose (canonicalizing a bare `#/`,
 * pinning the resolved repo), so Back doesn't have to step through them.
 */
export const navigate = (to: string, options?: { readonly replace?: boolean }): void => {
  if (window.location.hash === to) return
  if (options?.replace) {
    window.history.replaceState(null, "", to)
    // replaceState fires no hashchange, so the store has to be nudged by hand
    // or nothing re-renders.
    emit()
  } else {
    window.location.hash = to
  }
}

/**
 * A real anchor, which is the point: it is bookmarkable, middle-clickable and
 * announced as a link. Before routing, this app contained no `<a href>` at all.
 */
export const Link = ({
  to,
  children,
  className,
  title,
  ariaCurrent,
}: {
  to: string
  children: ReactNode
  className?: string
  title?: string
  ariaCurrent?: boolean
}) => (
  <a href={to} className={className} title={title} {...(ariaCurrent ? { "aria-current": "page" as const } : {})}>
    {children}
  </a>
)
