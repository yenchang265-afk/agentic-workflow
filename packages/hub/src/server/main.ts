import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "@agentic-loop/core/config"
import { defaultLoopsDir } from "@agentic-loop/core/manifest/dir"
import { STATUSES } from "@agentic-loop/core/task/store"
import type { ReposResponse } from "../shared/api.js"
import type { HubDeps } from "./deps.js"
import { makeEventHub } from "./events.js"
import { fsClient, sh } from "./fsclient.js"
import { badRequest, makeListener, ok, type JsonResponse, type ParsedRequest, type RawRoute, type Route } from "./http.js"
import { HUB_CONFIG_NAME, parseHubConfig, resolveRepos } from "./repos.js"
import { startWatcher } from "./watch.js"
import { getActive } from "./routes/active.js"
import { getBacklog, getTaskDetail } from "./routes/backlog.js"
import { getKind, getKinds, saveKind, validateKind } from "./routes/kinds.js"
import { getManualFreshness, MANUAL_PATH } from "./routes/manual.js"
import { getRunDetail, getRuns } from "./routes/runs.js"
import { getRunTokens, getTokensSummary } from "./routes/tokens.js"
import { defaultOpencodeDbPath } from "./tokens/opencodedb.js"
import { defaultProjectsDir } from "./tokens/transcripts.js"

/**
 * Hub server entry. Binds 127.0.0.1 only — this is a local admin tool, never
 * an exposed service. Repos to monitor come from repeatable `--dir <path>`
 * flags (values may contain `*` wildcards — see repos.ts), or, when no --dir
 * is given, from a hub.config.json `{ "repos": [...], "port"?: n }` in the
 * cwd. With neither the hub exits — it never watches a repo you didn't name.
 * `--port <n>` overrides the port. Repo-scoped routes take `?repo=<id>`
 * (default: the first repo).
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

let patterns = dirArgs
let configPort: number | undefined
if (patterns.length === 0) {
  try {
    const raw = fs.readFileSync(path.join(cwd, HUB_CONFIG_NAME), "utf8")
    const config = parseHubConfig(raw)
    patterns = [...config.repos]
    configPort = config.port
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error((err as Error).message)
    } else {
      console.error(
        `hub: no repos configured — pass --dir <path> (repeatable, * wildcards ok) or create ${HUB_CONFIG_NAME} with { "repos": [...] }`,
      )
    }
    process.exit(1)
  }
}

const { repos: resolved, notes } = resolveRepos(patterns, cwd)
for (const note of notes) process.stderr.write(`[hub] warn: ${note}\n`)
if (resolved.length === 0) {
  console.error("hub: no repos to monitor — check --dir values / hub.config.json")
  process.exit(1)
}

const port = Number(argValues("--port")[0] ?? configPort ?? 4317)

const log: HubDeps["log"] = (level, message) => process.stderr.write(`[hub] ${level}: ${message}\n`)

interface Repo {
  readonly id: string
  readonly deps: HubDeps
}

const repos: Repo[] = []
for (const { id, directory } of resolved) {
  const config = await loadConfig(fsClient, directory)
  repos.push({
    id,
    deps: {
      directory,
      tasksDir: config.tasksDir,
      loopsDir: defaultLoopsDir(),
      projectsDir: defaultProjectsDir(),
      opencodeDbPath: defaultOpencodeDbPath(),
      client: fsClient,
      sh,
      log,
    },
  })
}

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

// Kind routes stay unscoped: loop kinds live in the core package, shared by every repo.
const routes: Route[] = [
  { method: "GET", pattern: "/api/repos", handler: async () => ok(reposResponse) },
  { method: "GET", pattern: "/api/backlog", handler: scoped((deps) => getBacklog(deps)) },
  { method: "GET", pattern: "/api/tasks/:status/:id", handler: scoped(getTaskDetail) },
  { method: "GET", pattern: "/api/kinds", handler: () => getKinds(defaultRepo.deps) },
  { method: "GET", pattern: "/api/kinds/:kind", handler: (req) => getKind(defaultRepo.deps, req) },
  { method: "GET", pattern: "/api/runs", handler: scoped((deps) => getRuns(deps)) },
  { method: "GET", pattern: "/api/runs/:id", handler: scoped(getRunDetail) },
  { method: "GET", pattern: "/api/active", handler: scoped((deps) => getActive(deps)) },
  { method: "GET", pattern: "/api/tokens", handler: scoped((deps) => getTokensSummary(deps)) },
  { method: "GET", pattern: "/api/tokens/:id", handler: scoped(getRunTokens) },
  { method: "POST", pattern: "/api/kinds/validate", handler: (req) => validateKind(defaultRepo.deps, req) },
  { method: "POST", pattern: "/api/kinds/:kind", handler: (req) => saveKind(defaultRepo.deps, req), mutating: true },
  { method: "GET", pattern: "/api/manual/freshness", handler: scoped((deps) => getManualFreshness(deps)) },
]

const events = makeEventHub()
const watcherStops = repos.map((repo) =>
  startWatcher(
    { directory: repo.deps.directory, tasksDir: repo.deps.tasksDir, statuses: STATUSES },
    (evts) => events.broadcast(evts.map((e) => ({ ...e, repo: repo.id }))),
  ),
)

const rawRoutes: RawRoute[] = [
  { method: "GET", pattern: "/api/events", handle: (req, res) => events.handle(req, res) },
  {
    method: "GET",
    pattern: "/manual",
    handle: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const repo = byId.get(url.searchParams.get("repo") ?? defaultRepo.id)
      if (!repo) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        res.end(`unknown repo ${url.searchParams.get("repo")}`)
        return
      }
      try {
        const html = fs.readFileSync(path.join(repo.deps.directory, MANUAL_PATH))
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(html)
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        res.end("this repo has no docs/manual.html")
      }
    },
  },
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
  for (const stop of watcherStops) stop()
  events.close()
  server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
