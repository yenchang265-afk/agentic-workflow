import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { RepoInfo, ReposResponse } from "../shared/api.js"
import { fetchJson } from "./api.js"
import { useEvents } from "./events.js"

/**
 * Which monitored repo the UI is looking at. The hub can watch several repos
 * (`--dir` globs / user-scope `hub.repos`); every repo-scoped fetch appends
 * `?repo=<id>` via repoPath. Selection persists in localStorage.
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

  // Re-runs when the server registers a newly loop-enabled repo (SSE `repos`
  // event); the localStorage check keeps the user's current selection.
  useEffect(() => {
    let cancelled = false
    fetchJson<ReposResponse>("/api/repos")
      .then((d) => {
        if (cancelled) return
        setRepos(d.repos)
        const saved = localStorage.getItem(STORAGE_KEY)
        setRepoIdState(d.repos.some((r) => r.id === saved) ? saved : (d.repos[0]?.id ?? null))
      })
      .catch(() => {
        if (!cancelled) setRepoIdState(null)
      })
    return () => {
      cancelled = true
    }
  }, [versions.repos])

  const setRepoId = (id: string): void => {
    localStorage.setItem(STORAGE_KEY, id)
    setRepoIdState(id)
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
