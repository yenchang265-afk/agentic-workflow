import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { RepoInfo, ReposResponse } from "../shared/api.js"
import { fetchJson } from "./api.js"
import { useEvents } from "./events.js"
import { withQuery } from "./route.js"
import { navigate, useRoute } from "./routing.js"
import { selectedRepo } from "./selectedrepo.js"

/**
 * Which monitored repo the UI is looking at. The hub can watch several repos
 * (`--dir` globs / user-scope `hub.repos`); every repo-scoped fetch appends
 * `?repo=<id>` via repoPath.
 *
 * The selection lives in the URL (`#/monitor?repo=web-app`) and falls back to
 * localStorage, so a link carries the repo it was taken in — the server has
 * always spoken "repo" as a URL concept and the client now does too — while a
 * plain reload still lands where you left off.
 */

const STORAGE_KEY = "hub.repo"

interface RepoValue {
  readonly repos: readonly RepoInfo[]
  /** Null until /api/repos answers — fetches then hit the server default. */
  readonly repoId: string | null
  readonly setRepoId: (id: string) => void
}

const RepoContext = createContext<RepoValue>({ repos: [], repoId: null, setRepoId: () => {} })

export const RepoProvider = ({ children }: { children: ReactNode }) => {
  const [repos, setRepos] = useState<readonly RepoInfo[]>([])
  const [repoId, setRepoIdState] = useState<string | null>(null)
  const { versions } = useEvents()
  const route = useRoute()
  const fromUrl = route.query.repo

  // Re-runs when the server registers a newly loop-enabled repo (SSE `repos`
  // event) or the URL names a different one. Precedence: the URL (so a shared
  // link opens the repo it was taken in), then localStorage, then the server's
  // first repo — each only if it still exists in the list.
  useEffect(() => {
    let cancelled = false
    fetchJson<ReposResponse>("/api/repos")
      .then((d) => {
        if (cancelled) return
        setRepos(d.repos)
        const exists = (id: string | null | undefined): id is string => !!id && d.repos.some((r) => r.id === id)
        const saved = localStorage.getItem(STORAGE_KEY)
        setRepoIdState(exists(fromUrl) ? fromUrl : exists(saved) ? saved : (d.repos[0]?.id ?? null))
      })
      .catch(() => {
        if (!cancelled) setRepoIdState(null)
      })
    return () => {
      cancelled = true
    }
  }, [versions.repos, fromUrl])

  // Publish for EventsProvider, which filters events by repo but sits outside
  // this context. An effect rather than a render-time write so the value the
  // event handler reads is the one that actually committed.
  useEffect(() => {
    selectedRepo.current = repoId
  }, [repoId])

  const setRepoId = (id: string): void => {
    localStorage.setItem(STORAGE_KEY, id)
    setRepoIdState(id)
    // Replace rather than push: picking a repo corrects where you are, it isn't
    // a place you'd want Back to step through one repo at a time.
    navigate(withQuery(route, { repo: id }), { replace: true })
  }

  return <RepoContext.Provider value={{ repos, repoId, setRepoId }}>{children}</RepoContext.Provider>
}

export const useRepo = (): RepoValue => useContext(RepoContext)

/** Append the `repo` query param to an API path (no-op before repos load). */
export const repoPath = (path: string, repoId: string | null): string =>
  repoId === null ? path : `${path}${path.includes("?") ? "&" : "?"}repo=${encodeURIComponent(repoId)}`

/** Header dropdown — rendered only when more than one repo is monitored. */
export const RepoPicker = () => {
  const { repos, repoId, setRepoId } = useRepo()
  if (repos.length < 2) return null
  return (
    <select
      className="repo-picker"
      value={repoId ?? ""}
      onChange={(e) => setRepoId(e.target.value)}
      title={repos.find((r) => r.id === repoId)?.directory}
    >
      {repos.map((r) => (
        <option key={r.id} value={r.id} title={r.directory}>
          {r.id}
        </option>
      ))}
    </select>
  )
}
