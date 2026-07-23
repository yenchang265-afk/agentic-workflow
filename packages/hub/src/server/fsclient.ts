import { spawn } from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import type { Client, FileNode, Shell, ShellOutput } from "@agentic-workflow/core/host"
import { containedIn } from "./paths.js"

/**
 * Node implementations of the `@agentic-workflow/core` host interfaces so the hub
 * server can drive the shared backlog/lease helpers directly — same substrate
 * pattern as the Claude MCP server's shim (plugins/claude/mcp-server/src/shim.ts).
 */

type RawExpr = { readonly raw: string }
const isRaw = (v: unknown): v is RawExpr => typeof v === "object" && v !== null && "raw" in v

/** Single-quote-escape a value for safe shell interpolation. */
const esc = (v: unknown): string => `'${String(v).replace(/'/g, "'\\''")}'`

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

class ShellPromise implements PromiseLike<ShellOutput> {
  #cmd: string
  #cwd: string | undefined
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
  #exec(): Promise<ShellOutput> {
    return (this.#run ??= new Promise<ShellOutput>((resolve) => {
      const child = spawn("bash", ["-c", this.#cmd], { cwd: this.#cwd })
      let out = ""
      let err = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (err += d))
      child.on("error", () => resolve({ exitCode: 127, stdout: strOut(out), stderr: strOut(err || "spawn error") }))
      child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout: strOut(out), stderr: strOut(err) }))
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

/**
 * Containment rail: the resolved target must stay inside `directory`. Every
 * current caller builds `query.path` from validated ids, but this is the hub's
 * shared FS reader — a future route passing user input as `path` must not
 * inherit a traversal primitive (`..` or an absolute path would escape the
 * repo silently, since `path.resolve` honors both).
 */
const contained = containedIn

/**
 * Refuse to materialize any single file larger than this (a runaway run log,
 * a giant transcript). Oversize reads report "unreadable" (null) — dropping
 * one pathological file from a view beats freezing or OOMing the whole hub.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024

export const fsClient: Client = {
  file: {
    // Truly-async fs so a large runs/ history doesn't block the event loop
    // (readFileSync here serialized every concurrent request AND the SSE
    // heartbeats behind whole-directory scans).
    async list({ query }) {
      const abs = contained(query.directory, query.path)
      if (!abs) return { data: [] }
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true })
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
      const abs = contained(query.directory, query.path)
      if (!abs) return { data: null }
      try {
        const st = await fsp.stat(abs)
        if (!st.isFile() || st.size > MAX_READ_BYTES) return { data: null }
        return { data: { content: await fsp.readFile(abs, "utf8") } }
      } catch {
        return { data: null }
      }
    },
  },
  app: {
    async log({ body }) {
      process.stderr.write(`[${body.service}] ${body.level}: ${body.message}\n`)
    },
  },
}
