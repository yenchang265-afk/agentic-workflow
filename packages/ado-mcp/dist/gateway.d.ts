import type { Log } from "@agentic-workflow/core/host";
import type { AdoGateway } from "@agentic-workflow/core/source/ado-gateway";
import type { AdoConfig } from "@agentic-workflow/core/workflow/state";
/**
 * The Azure DevOps MCP client behind core's `AdoGateway` port.
 *
 * Lifecycle is the opinionated part: ONE long-lived client, lazily connected,
 * reused across polls. `npx -y` cold start is seconds, and a single PR poll can
 * page the list ten times and then fetch threads per PR — spawning a server per
 * call would put that cost on every one of those. So `ensure()` memoizes a
 * connect promise, and a failure nulls it so the next tick reconnects.
 *
 * A failure is never thrown at the poller: every method returns
 * `{ ok: false, error }`, which each core call site already turns into an
 * actionable claim-skip. The reconnect cooldown exists so a permanently bad
 * credential fails fast instead of respawning a child process on every tick.
 */
export interface AdoMcpGatewayOptions {
    /** Usually "npx". */
    readonly command: string;
    /** e.g. ["-y", "@azure-devops/mcp@2.8.1", "acme", "-d", "repositories", "-d", "pipelines", "-a", "pat"] */
    readonly args: readonly string[];
    /** Child env — carries PERSONAL_ACCESS_TOKEN. Never merged into `process.env`. */
    readonly env: Readonly<Record<string, string>>;
    readonly log: Log;
    /** Minimum gap between reconnect attempts after a failure. Default 30s. */
    readonly reconnectCooldownMs?: number;
    /** Per-call timeout, so a hung child cannot wedge the scheduler. Default 60s. */
    readonly callTimeoutMs?: number;
    /** Clock injection for tests. */
    readonly now?: () => number;
    /**
     * Connection injection for tests — supply a fake to exercise the lifecycle
     * without spawning a server. Defaults to a real stdio-connected `Client`.
     */
    readonly connect?: () => Promise<McpClientLike>;
}
/** The subset of the MCP SDK `Client` this adapter uses. */
export interface McpClientLike {
    callTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
    }, resultSchema?: unknown, options?: {
        timeout?: number;
    }): Promise<unknown>;
    listTools(): Promise<{
        tools: readonly {
            name: string;
        }[];
    }>;
    close(): Promise<void>;
}
export declare const makeAdoMcpGateway: (opts: AdoMcpGatewayOptions) => AdoGateway;
/**
 * Build the gateway a host threads into `buildWorkSources` and the ship gate,
 * or `undefined` when this install has no Azure DevOps configured (the common
 * case — a GitHub-only user must never spawn `npx`).
 *
 * A spawn spec that cannot be built (no credential, an unusable auth mode, an
 * organization URL with no org name in it) is reported once here and treated as
 * "no gateway": the ado-platform kinds then skip with an actionable message
 * instead of the whole host failing to start.
 *
 * Nothing is spawned by this call. The server starts on the first actual
 * request, so a misconfigured-but-unused ADO section costs nothing.
 */
export declare const adoGatewayFromConfig: (config: {
    readonly ado?: AdoConfig;
}, log: Log, env?: Readonly<Record<string, string | undefined>>) => AdoGateway | undefined;
export declare const sharedAdoGateway: (config: {
    readonly ado?: AdoConfig;
}, log: Log, env?: Readonly<Record<string, string | undefined>>) => AdoGateway | undefined;
/** Shut the shared gateway down — for host teardown. Safe when none was built. */
export declare const closeSharedAdoGateway: () => Promise<void>;
