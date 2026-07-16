import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ReposResponse } from "../shared/api.js"
import type { HubDeps } from "./deps.js"
import { makeEventHub } from "./events.js"
import { badRequest, makeListener, ok, type JsonResponse, type ParsedRequest, type RawRoute, type Route } from "./http.js"
import { loadHubSettings } from "./config.js"
import { makeRepo, watchShape, type Repo } from "./repo.js"
import { resolveRepos } from "./repos.js"
import { startWatcher } from "./watch.js"
import { getActive } from "./routes/active.js"
import { getBacklog, getTaskDetail } from "./routes/backlog.js"
import { getConfig, saveConfig } from "./routes/config.js"
import { getDoctor, postDoctorFix } from "./routes/doctor.js"
import { postGate } from "./routes/gate.js"
import { getKind, getKinds, previewKind, saveKind, validateKind } from "./routes/kinds.js"
import { getRunDetail, getRuns } from "./routes/runs.js"
import { getRunTokens, getTokensSummary } from "./routes/tokens.js"

/**
 * Hub server entry. Binds 127.0.0.1 only — this is a local admin tool, never
 * an exposed service. Repos to monitor come from repeatable `--dir <path>`
 * flags (values may contain `*` wildcards — see repos.ts), or, when no --dir
 * is given, from the `hub` section of the user-scope `~/.agentic-loop.json`
 * (`{ "hub": { "repos": [...], "port"?: n } }` — see config.ts; a repo-level
 * `hub` key is ignored). With neither the hub exits — it never watches a repo
 * you didn't name. `--port <n>` overrides the port. Repo-scoped routes take
 * `?repo=<id>` (default: the first repo).
 */

const argValues = (flag: string): string[] => {
  const values: string[] = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined) values.push(process.argv[i + 1] as string)
  }
  return values
}

const cwd = process.cwd()
const dirArgs = argValues("--dir")

let settings: ReturnType<typeof loadHubSettings> = null
try {
  settings = loadHubSettings()
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

const patterns = dirArgs.length > 0 ? dirArgs : [...(settings?.repos ?? [])]
if (patterns.length === 0) {
  console.error(
    'hub: no repos configured — pass --dir <path> (repeatable, * wildcards ok) or set { "hub": { "repos": [...] } } in ~/.agentic-loop.json',
  )
  process.exit(1)
}

const { repos: resolved, notes } = resolveRepos(patterns, cwd)
for (const note of notes) process.stderr.write(`[hub] warn: ${note}\n`)
if (resolved.length === 0) {
  console.error("hub: no repos to monitor — check --dir values / the hub.repos entries in ~/.agentic-loop.json")
  process.exit(1)
}

const port = Number(argValues("--port")[0] ?? settings?.port ?? 4317)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  // Guard the parse: `--port foo` → NaN, and `listen(NaN)` silently binds a
  // random ephemeral port, so the URL we print below would be wrong.
  console.error(`hub: invalid --port "${argValues("--port")[0] ?? settings?.port}" — expected an integer 0–65535`)
  process.exit(1)
}

const log: HubDeps["log"] = (level, message) => process.stderr.write(`[hub] ${level}: ${message}\n`)

const events = makeEventHub()

const watcherStops = new Map<string, () => void>()

const restartWatcher = (repo: Repo): void => {
  watcherStops.get(repo.id)?.()
  watcherStops.set(
    repo.id,
    startWatcher(watchShape(repo.deps), async (evts) => {
      // Reload BEFORE fanning out: a `config` event tells clients to refetch, and
      // they must not refetch against the config the server has just been told is
      // stale. Covers hand-edits in $EDITOR as well as the hub's own save.
      if (evts.some((e) => e.type === "config")) await repo.reload()
      events.broadcast(evts.map((e) => ({ ...e, repo: repo.id })))
    }),
  )
}

const repos: Repo[] = []
for (const { id, directory } of resolved) repos.push(await makeRepo(id, directory, log, restartWatcher))

const byId = new Map(repos.map((r) => [r.id, r]))
const defaultRepo = repos[0] as Repo

/** Resolve the repo a request targets (`?repo=<id>`, default first). */
const pickRepo = (req: ParsedRequest): Repo | null => {
  const id = req.query.get("repo")
  if (id === null) return defaultRepo
  return byId.get(id) ?? null
}

type RepoHandler = (deps: HubDeps, req: ParsedRequest) => Promise<JsonResponse>

const scoped =
  (handler: RepoHandler) =>
  async (req: ParsedRequest): Promise<JsonResponse> => {
    const repo = pickRepo(req)
    if (!repo) return badRequest(`unknown repo ${req.query.get("repo")}`)
    return handler(repo.deps, req)
  }

const reposResponse: ReposResponse = {
  repos: repos.map((r) => ({ id: r.id, directory: r.deps.directory })),
}

/**
 * The loop-kind manifests themselves live in the core package and are shared by
 * every repo, but these handlers read the *repo* around them — saveKind's
 * checklist probes `deps.directory` for agent personas, command wrappers, and
 * the kind's `.agentic-loop.json` entry. Unscoped they answered for the first
 * repo whatever `?repo=` asked for, so they are scoped like everything else.
 */
const routes: Route[] = [
  { method: "GET", pattern: "/api/repos", handler: async () => ok(reposResponse) },
  { method: "GET", pattern: "/api/monitor/kinds", handler: scoped(async (deps) => ok({ kinds: deps.boards })) },
  { method: "GET", pattern: "/api/backlog", handler: scoped(getBacklog) },
  { method: "GET", pattern: "/api/tasks/:status/:id", handler: scoped(getTaskDetail) },
  { method: "GET", pattern: "/api/kinds", handler: scoped((deps) => getKinds(deps)) },
  { method: "GET", pattern: "/api/kinds/:kind", handler: scoped(getKind) },
  { method: "GET", pattern: "/api/runs", handler: scoped((deps) => getRuns(deps)) },
  { method: "GET", pattern: "/api/runs/:id", handler: scoped(getRunDetail) },
  { method: "GET", pattern: "/api/active", handler: scoped((deps) => getActive(deps)) },
  { method: "GET", pattern: "/api/tokens", handler: scoped((deps) => getTokensSummary(deps)) },
  { method: "GET", pattern: "/api/tokens/:id", handler: scoped(getRunTokens) },
  // validate/preview write nothing, so they carry no `mutating` guard — the
  // X-Hub-Client header gates side effects, not reads that happen to POST.
  { method: "POST", pattern: "/api/kinds/validate", handler: scoped(validateKind) },
  { method: "POST", pattern: "/api/kinds/preview", handler: scoped(previewKind) },
  { method: "POST", pattern: "/api/kinds/:kind", handler: scoped(saveKind), mutating: true },
  { method: "POST", pattern: "/api/gate/:action", handler: scoped(postGate), mutating: true },
  { method: "GET", pattern: "/api/config", handler: scoped(getConfig) },
  { method: "POST", pattern: "/api/config", handler: scoped(saveConfig), mutating: true },
  { method: "GET", pattern: "/api/doctor", handler: scoped((deps) => getDoctor(deps)) },
  { method: "POST", pattern: "/api/doctor/fix", handler: scoped((deps) => postDoctorFix(deps)), mutating: true },
]

for (const repo of repos) restartWatcher(repo)

const rawRoutes: RawRoute[] = [
  { method: "GET", pattern: "/api/events", handle: (req, res) => events.handle(req, res) },
]

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web")
const server = http.createServer(makeListener(routes, webRoot, rawRoutes))
server.listen(port, "127.0.0.1", () => {
  const watched =
    repos.length === 1
      ? defaultRepo.deps.directory
      : `${repos.length} repos: ${repos.map((r) => r.id).join(", ")}`
  console.log(`agentic-loop hub: http://127.0.0.1:${port} (watching ${watched})`)
})

const shutdown = (): void => {
  for (const stop of watcherStops.values()) stop()
  events.close()
  server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
