import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Runtime shims that stand in for the two OpenCode host capabilities the ported
 * lib modules (git.ts, store.ts, persist.ts, config.ts) expect: the Bun shell
 * `$` and the opencode `client`. Backed by node's child_process + fs so the
 * exact same module bodies run inside the MCP server. See
 * docs/design/improvements — the Claude Code port keeps the loop logic and only
 * swaps its IO substrate.
 */

// --- Shell ($) shim: a Bun-`$`-compatible tagged template over `bash -c` ---

export interface ShellOutput {
  readonly exitCode: number
  readonly stdout: { toString(): string }
  readonly stderr: { toString(): string }
}

/** A `{ raw }` interpolation is spliced in unescaped, matching Bun's `$` behavior. */
type RawExpr = { readonly raw: string }
const isRaw = (v: unknown): v is RawExpr => typeof v === "object" && v !== null && "raw" in v

/** Single-quote-escape a value for safe shell interpolation (Bun `$` auto-escapes too). */
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
export type Shell = (strings: TemplateStringsArray, ...exprs: unknown[]) => ShellPromise
export const sh: Shell = (strings, ...exprs) => new ShellPromise(render(strings, exprs))

// --- Client shim: opencode file.list/read + app.log over node fs + stderr ---

export interface FileNode {
  readonly type: "file" | "directory"
  readonly name: string
  readonly path: string
  readonly absolute: string
}

export interface Client {
  readonly file: {
    list(args: { query: { path: string; directory: string } }): Promise<{ data: FileNode[] }>
    read(args: { query: { path: string; directory: string } }): Promise<{ data: { content: string } | null }>
  }
  readonly app: {
    log(args: { body: { service: string; level: string; message: string } }): Promise<void>
  }
}

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
