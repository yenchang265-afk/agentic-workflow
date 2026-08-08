import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { Client, FileNode, Shell, ShellOutput } from "@agentic-workflow/core/host"

/**
 * Runtime implementations of the `@agentic-workflow/core` host interfaces
 * (`host.ts`): the shell `$` and the file/log `client`. Backed by node's
 * child_process + fs so the shared core modules run inside the MCP server —
 * the server is the substrate adapter, core is the behavior.
 */

// --- Shell ($) shim: a Bun-`$`-compatible tagged template over `bash -c` ---

/** A `{ raw }` interpolation is spliced in unescaped, matching Bun's `$` behavior. */
type RawExpr = { readonly raw: string }
const isRaw = (v: unknown): v is RawExpr => typeof v === "object" && v !== null && "raw" in v

/** Single-quote-escape a value for safe shell interpolation (Bun `$` auto-escapes too). */
const esc = (v: unknown): string => `'${String(v).replace(/'/g, "'\\''")}'`

/** Per-stream capture cap (10 MiB). Loop commands read task files and git
 *  output — never legitimately more than this; past it the stream is dropped. */
const MAX_CAPTURE = 10 * 1024 * 1024

const render = (strings: TemplateStringsArray, exprs: unknown[]): string => {
  let cmd = ""
  strings.forEach((s, i) => {
    cmd += s
    if (i < exprs.length) {
      const e = exprs[i]
      cmd += isRaw(e) ? e.raw : Array.isArray(e) ? e.map(esc).join(" ") : esc(e)
    }
  })
  return cmd
}

/** Grace between SIGTERM and SIGKILL for a timed-out command. */
const KILL_GRACE_MS = 5_000

class ShellPromise implements PromiseLike<ShellOutput> {
  #cmd: string
  #cwd: string | undefined
  #timeoutMs: number | undefined
  #run: Promise<ShellOutput> | undefined
  constructor(cmd: string) {
    this.#cmd = cmd
  }
  quiet(): this {
    return this
  }
  nothrow(): this {
    return this
  }
  cwd(dir: string): this {
    this.#cwd = dir
    return this
  }
  /**
   * Kill the child after `ms` and resolve exit 124, the `timeout(1)` convention
   * core's `classifyExit` reads as "the check could not run". This host owns its
   * `spawn`, so unlike core's race fallback it actually reaps the process.
   */
  timeout(ms: number): this {
    this.#timeoutMs = ms
    return this
  }
  #exec(): Promise<ShellOutput> {
    return (this.#run ??= new Promise<ShellOutput>((resolve) => {
      const child = spawn("bash", ["-c", this.#cmd], { cwd: this.#cwd })
      let out = ""
      let err = ""
      // Cap accumulation: a runaway `git log`/`cat` must not balloon the server's
      // memory. Callers get the head of the stream plus a truncation marker.
      const append = (buf: string, d: unknown): string =>
        buf.length >= MAX_CAPTURE ? buf : (buf + String(d)).slice(0, MAX_CAPTURE)
      child.stdout.on("data", (d) => (out = append(out, d)))
      child.stderr.on("data", (d) => (err = append(err, d)))
      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const deadline =
        this.#timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              child.kill("SIGTERM")
              killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
              killTimer.unref?.()
            }, this.#timeoutMs)
      deadline?.unref?.()
      const settle = (o: ShellOutput) => {
        clearTimeout(deadline)
        clearTimeout(killTimer)
        resolve(o)
      }
      // A spawn failure (bash missing, EPERM) is NOT command-not-found: keep the
      // 127 contract for callers, but name the real cause in stderr so the two
      // are distinguishable in logs.
      child.on("error", (e) => settle({ exitCode: 127, stdout: strOut(out), stderr: strOut(`spawn failed (not a command error): ${e.message}`) }))
      child.on("close", (code) =>
        // A kill lands as a SIGNAL exit, so `code` is null and the plain `?? 0`
        // would report SUCCESS for a command we just killed.
        timedOut
          ? settle({
              exitCode: 124,
              stdout: strOut(out),
              stderr: strOut(`${err}\ntimed out after ${Math.round((this.#timeoutMs ?? 0) / 1000)}s — killed`),
            })
          : settle({ exitCode: code ?? 0, stdout: strOut(out), stderr: strOut(err) }),
      )
    }))
  }
  then<T1 = ShellOutput, T2 = never>(
    onfulfilled?: ((value: ShellOutput) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.#exec().then(onfulfilled, onrejected)
  }
}

const strOut = (s: string) => ({ toString: () => s })

/** Bun-`$`-compatible tagged template. Never throws; capture via .exitCode/.stdout/.stderr. */
export const sh: Shell = (strings, ...exprs) => new ShellPromise(render(strings, exprs))

// --- Client shim: file.list/read + app.log over node fs + stderr ---

export const fsClient: Client = {
  file: {
    async list({ query }) {
      const abs = path.resolve(query.directory, query.path)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return { data: [] }
      }
      const data: FileNode[] = entries.map((e) => ({
        type: e.isDirectory() ? "directory" : "file",
        name: e.name,
        path: path.join(query.path, e.name),
        absolute: path.join(abs, e.name),
      }))
      return { data }
    },
    async read({ query }) {
      const abs = path.resolve(query.directory, query.path)
      try {
        return { data: { content: fs.readFileSync(abs, "utf8") } }
      } catch {
        return { data: null }
      }
    },
  },
  app: {
    async log({ body }) {
      // MCP servers must keep stdout clean for the protocol — log to stderr.
      process.stderr.write(`[${body.service}] ${body.level}: ${body.message}\n`)
    },
  },
}
