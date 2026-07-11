import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "@agentic-loop/core/config"
import { defaultLoopsDir } from "@agentic-loop/core/manifest/dir"
import { STATUSES } from "@agentic-loop/core/task/store"
import type { HubDeps } from "./deps.js"
import { makeEventHub } from "./events.js"
import { fsClient, sh } from "./fsclient.js"
import { makeListener, type RawRoute, type Route } from "./http.js"
import { startWatcher } from "./watch.js"
import { getActive } from "./routes/active.js"
import { getBacklog, getTaskDetail } from "./routes/backlog.js"
import { getKind, getKinds } from "./routes/kinds.js"
import { getRunDetail, getRuns } from "./routes/runs.js"
import { getRunTokens, getTokensSummary } from "./routes/tokens.js"
import { defaultOpencodeDbPath } from "./tokens/opencodedb.js"
import { defaultProjectsDir } from "./tokens/transcripts.js"

/**
 * Hub server entry. Binds 127.0.0.1 only — this is a local admin tool, never
 * an exposed service. `--dir <repo>` points at the project to monitor
 * (default: cwd); `--port <n>` overrides the default port.
 */

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const directory = path.resolve(argValue("--dir") ?? process.cwd())
const port = Number(argValue("--port") ?? 4317)

const config = await loadConfig(fsClient, directory)

const deps: HubDeps = {
  directory,
  tasksDir: config.tasksDir,
  loopsDir: defaultLoopsDir(),
  projectsDir: defaultProjectsDir(),
  opencodeDbPath: defaultOpencodeDbPath(),
  client: fsClient,
  sh,
  log: (level, message) => process.stderr.write(`[hub] ${level}: ${message}\n`),
}

const routes: Route[] = [
  { method: "GET", pattern: "/api/backlog", handler: () => getBacklog(deps) },
  { method: "GET", pattern: "/api/tasks/:status/:id", handler: (req) => getTaskDetail(deps, req) },
  { method: "GET", pattern: "/api/kinds", handler: () => getKinds(deps) },
  { method: "GET", pattern: "/api/kinds/:kind", handler: (req) => getKind(deps, req) },
  { method: "GET", pattern: "/api/runs", handler: () => getRuns(deps) },
  { method: "GET", pattern: "/api/runs/:id", handler: (req) => getRunDetail(deps, req) },
  { method: "GET", pattern: "/api/active", handler: () => getActive(deps) },
  { method: "GET", pattern: "/api/tokens", handler: () => getTokensSummary(deps) },
  { method: "GET", pattern: "/api/tokens/:id", handler: (req) => getRunTokens(deps, req) },
]

const events = makeEventHub()
const stopWatcher = startWatcher({ directory, tasksDir: config.tasksDir, statuses: STATUSES }, (evts) =>
  events.broadcast(evts),
)

const rawRoutes: RawRoute[] = [{ method: "GET", pattern: "/api/events", handle: (req, res) => events.handle(req, res) }]

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web")
const server = http.createServer(makeListener(routes, webRoot, rawRoutes))
server.listen(port, "127.0.0.1", () => {
  console.log(`agentic-loop hub: http://127.0.0.1:${port} (watching ${directory})`)
})

const shutdown = (): void => {
  stopWatcher()
  events.close()
  server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
