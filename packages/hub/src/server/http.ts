import fs from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * A tiny router + static file server over node:http — no framework. Route
 * handlers are pure functions of parsed request data so they test without
 * sockets; the impure wiring (listen, headers, body streaming) lives here and
 * in main.ts.
 *
 * Safety posture (localhost tool, no auth):
 * - the server binds 127.0.0.1 only (main.ts)
 * - requests whose Host header is not local are rejected (DNS-rebinding guard)
 * - mutating routes additionally require the `X-Hub-Client: 1` header; the hub
 *   never serves CORS headers, so a cross-origin page can neither read
 *   responses nor send that header without a failing preflight
 */

export interface JsonResponse {
  readonly status: number
  readonly body: unknown
}

export interface ParsedRequest {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  readonly body?: unknown
}

export type Handler = (req: ParsedRequest) => Promise<JsonResponse>

export interface Route {
  readonly method: "GET" | "POST"
  readonly pattern: string
  readonly handler: Handler
  /** Mutating routes require the X-Hub-Client header. */
  readonly mutating?: boolean
}

/** A route that owns the raw response (SSE streams, non-JSON payloads). */
export interface RawRoute {
  readonly method: "GET"
  readonly pattern: string
  readonly handle: (req: IncomingMessage, res: ServerResponse, params: Readonly<Record<string, string>>) => void
}

export const json = (status: number, body: unknown): JsonResponse => ({ status, body })
export const ok = (body: unknown): JsonResponse => json(200, body)
export const notFound = (what: string): JsonResponse => json(404, { error: `${what} not found` })
export const badRequest = (error: string): JsonResponse => json(400, { error })

/**
 * Match a path against a `/api/tasks/:status/:id`-style pattern. Returns the
 * decoded params, or null when the shapes differ. Pure.
 */
export const matchRoute = (pattern: string, pathname: string): Record<string, string> | null => {
  const patSegs = pattern.split("/").filter(Boolean)
  const pathSegs = pathname.split("/").filter(Boolean)
  if (patSegs.length !== pathSegs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i] as string
    const seg = pathSegs[i] as string
    if (pat.startsWith(":")) {
      // A malformed percent-encoding (`/api/tasks/todo/%`) throws URIError; treat
      // it as no-match rather than letting it bubble out and hang the request.
      try {
        params[pat.slice(1)] = decodeURIComponent(seg)
      } catch {
        return null
      }
    } else if (pat !== seg) {
      return null
    }
  }
  return params
}

/**
 * Whether a decoded path param is a safe task/run id: no traversal, no
 * separators, no leading dot. `matchRoute` percent-decodes each segment, so a
 * raw `..%2f..` arrives here as `../..` — every route that feeds an id into a
 * filesystem lookup must screen it through this before touching disk. Pure.
 */
export const isSafeId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)

/** Whether a Host header addresses this machine locally. Pure. */
export const isLocalHost = (host: string | undefined): boolean => {
  if (!host) return false
  const name = host.replace(/:\d+$/, "")
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]"
}

/**
 * Resolve a URL path inside a static root, refusing anything that escapes it
 * (traversal, absolute paths). Returns the absolute file path or null. Pure
 * given the filesystem.
 */
export const safeStaticPath = (webRoot: string, urlPath: string): string | null => {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "")
  const abs = path.resolve(webRoot, rel)
  if (abs !== webRoot && !abs.startsWith(webRoot + path.sep)) return null
  return abs
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
}

const sendJson = (res: ServerResponse, out: JsonResponse): void => {
  const payload = JSON.stringify(out.body)
  res.writeHead(out.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(payload)
}

/** Cap on a POST body — hub payloads are small manifests/prompts. Over this,
 * the body is dropped (the handler validates and 400s) rather than buffered. */
const MAX_BODY_BYTES = 1_000_000

/**
 * Buffer the request body as Buffers (not string concatenation), cap the total
 * size, and decode once at the end. Concatenating string chunks corrupts a UTF-8
 * codepoint split across two TCP packets; a single decode over the joined bytes
 * does not. A missing/oversized/garbled body resolves to `undefined`.
 */
export const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: unknown) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on("data", (d: Buffer) => {
      if (done) return
      size += d.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        finish(undefined)
        return
      }
      chunks.push(d)
    })
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8")
        finish(raw ? JSON.parse(raw) : undefined)
      } catch {
        finish(undefined)
      }
    })
    req.on("error", () => finish(undefined))
  })

/**
 * Build the node:http request listener from the route table + static web
 * root. Unknown /api paths get JSON 404; everything else falls through to
 * static serving (SPA shell at /).
 */
export const makeListener = (routes: readonly Route[], webRoot: string, rawRoutes: readonly RawRoute[] = []) => {
  const root = path.resolve(webRoot)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Outer net: node:http does not await this async listener, so ANY throw
    // (a malformed URL, a decode error, a handler bug) would become an unhandled
    // rejection and leave the socket hanging. Catch everything and always answer.
    try {
      await handleRequest(req, res, root, routes, rawRoutes)
    } catch (err) {
      if (!res.headersSent) sendJson(res, json(500, { error: (err as Error).message }))
      else res.end()
    }
  }
}

/** The routed request pipeline, wrapped by makeListener's outer try/catch. */
const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  routes: readonly Route[],
  rawRoutes: readonly RawRoute[],
): Promise<void> => {
  if (!isLocalHost(req.headers.host)) {
    sendJson(res, json(403, { error: "hub only answers local requests" }))
    return
  }
  let url: URL
  try {
    url = new URL(req.url ?? "/", "http://localhost")
  } catch {
    sendJson(res, json(400, { error: "malformed request URL" }))
    return
  }
  const method = req.method === "POST" ? "POST" : "GET"

  for (const route of rawRoutes) {
    if (route.method !== method) continue
    const params = matchRoute(route.pattern, url.pathname)
    if (!params) continue
    route.handle(req, res, params)
    return
  }

  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchRoute(route.pattern, url.pathname)
    if (!params) continue
    if (route.mutating && req.headers["x-hub-client"] !== "1") {
      sendJson(res, json(403, { error: "missing X-Hub-Client header" }))
      return
    }
    const body = method === "POST" ? await readBody(req) : undefined
    sendJson(res, await route.handler({ params, query: url.searchParams, body }))
    return
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, notFound("route"))
    return
  }

  const file = safeStaticPath(root, url.pathname)
  if (file) {
    try {
      const content = fs.readFileSync(file)
      const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" })
      res.end(content)
      return
    } catch {
      // fall through to 404
    }
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  res.end("not found")
}
