import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const isRaw = (v) => typeof v === "object" && v !== null && "raw" in v;
/** Single-quote-escape a value for safe shell interpolation (Bun `$` auto-escapes too). */
const esc = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const render = (strings, exprs) => {
    let cmd = "";
    strings.forEach((s, i) => {
        cmd += s;
        if (i < exprs.length) {
            const e = exprs[i];
            cmd += isRaw(e) ? e.raw : Array.isArray(e) ? e.map(esc).join(" ") : esc(e);
        }
    });
    return cmd;
};
class ShellPromise {
    #cmd;
    #cwd;
    #run;
    constructor(cmd) {
        this.#cmd = cmd;
    }
    quiet() {
        return this;
    }
    nothrow() {
        return this;
    }
    cwd(dir) {
        this.#cwd = dir;
        return this;
    }
    #exec() {
        return (this.#run ??= new Promise((resolve) => {
            const child = spawn("bash", ["-c", this.#cmd], { cwd: this.#cwd });
            let out = "";
            let err = "";
            child.stdout.on("data", (d) => (out += d));
            child.stderr.on("data", (d) => (err += d));
            child.on("error", () => resolve({ exitCode: 127, stdout: strOut(out), stderr: strOut(err || "spawn error") }));
            child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout: strOut(out), stderr: strOut(err) }));
        }));
    }
    then(onfulfilled, onrejected) {
        return this.#exec().then(onfulfilled, onrejected);
    }
}
const strOut = (s) => ({ toString: () => s });
/** Bun-`$`-compatible tagged template. Never throws; capture via .exitCode/.stdout/.stderr. */
export const sh = (strings, ...exprs) => new ShellPromise(render(strings, exprs));
// --- Client shim: file.list/read + app.log over node fs + stderr ---
export const fsClient = {
    file: {
        async list({ query }) {
            const abs = path.resolve(query.directory, query.path);
            let entries;
            try {
                entries = fs.readdirSync(abs, { withFileTypes: true });
            }
            catch {
                return { data: [] };
            }
            const data = entries.map((e) => ({
                type: e.isDirectory() ? "directory" : "file",
                name: e.name,
                path: path.join(query.path, e.name),
                absolute: path.join(abs, e.name),
            }));
            return { data };
        },
        async read({ query }) {
            const abs = path.resolve(query.directory, query.path);
            try {
                return { data: { content: fs.readFileSync(abs, "utf8") } };
            }
            catch {
                return { data: null };
            }
        },
    },
    app: {
        async log({ body }) {
            // MCP servers must keep stdout clean for the protocol — log to stderr.
            process.stderr.write(`[${body.service}] ${body.level}: ${body.message}\n`);
        },
    },
};
