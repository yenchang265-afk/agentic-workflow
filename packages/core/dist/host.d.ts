/**
 * The host substrate every core module runs against. Each plugin provides its
 * own implementation once and threads it through:
 *
 * - The OpenCode plugin passes Bun's `$` and the opencode SDK client, which
 *   satisfy these interfaces structurally.
 * - The Claude Code MCP server passes the node shims in
 *   `plugins/claude/mcp-server/src/shim.ts` (child_process + fs).
 *
 * Nothing in core may import a host SDK (`@opencode-ai/plugin`,
 * `@modelcontextprotocol/sdk`) — this module is the entire host surface.
 */
export interface ShellOutput {
    readonly exitCode: number;
    readonly stdout: {
        toString(): string;
    };
    readonly stderr: {
        toString(): string;
    };
}
/** The subset of a spawned shell command's promise the core relies on. */
export interface ShellPromise extends PromiseLike<ShellOutput> {
    quiet(): ShellPromise;
    nothrow(): ShellPromise;
    cwd(dir: string): ShellPromise;
}
/**
 * A Bun-`$`-compatible tagged template. Interpolations are shell-escaped;
 * a `{ raw }` interpolation is spliced in unescaped. Never throws when
 * `.nothrow()` is chained; capture via `.exitCode`/`.stdout`/`.stderr`.
 *
 * `exprs` is `any[]` on purpose: hosts declare their own expression unions
 * (Bun's `ShellExpression`), and a `unknown[]` here would reject them under
 * strict contravariance.
 */
export type Shell = (strings: TemplateStringsArray, ...exprs: any[]) => ShellPromise;
export interface FileNode {
    readonly type: "file" | "directory";
    readonly name: string;
    readonly path: string;
    readonly absolute: string;
}
/** The subset of the opencode client the core relies on (file IO + logging). */
export interface Client {
    readonly file: {
        list(args: {
            query: {
                path: string;
                directory: string;
            };
        }): Promise<{
            data?: FileNode[] | null;
        }>;
        read(args: {
            query: {
                path: string;
                directory: string;
            };
        }): Promise<{
            data?: {
                content: string;
            } | null;
        }>;
    };
    readonly app: {
        log(args: {
            body: {
                service: string;
                level: "info" | "warn" | "error" | "debug";
                message: string;
            };
        }): Promise<unknown>;
    };
}
/** Leveled logger threaded into core helpers that warn-and-continue. */
export type Log = (level: "info" | "warn" | "error", message: string) => unknown;
