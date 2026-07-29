import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { adoMcpSpawn } from "@agentic-workflow/core/source/ado-shared";
import { ADO_TOOLS } from "@agentic-workflow/core/source/ado-tools";
import { unwrapAdoResult } from "./unwrap.js";
const DEFAULT_RECONNECT_COOLDOWN_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Drop undefined-valued keys so optional port arguments are omitted rather than sent as null. */
const defined = (args) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
export const makeAdoMcpGateway = (opts) => {
    const { command, args, env, log } = opts;
    const cooldownMs = opts.reconnectCooldownMs ?? DEFAULT_RECONNECT_COOLDOWN_MS;
    const timeout = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const now = opts.now ?? (() => Date.now());
    let session = null;
    let lastFailureAt = 0;
    let closed = false;
    const defaultConnect = async () => {
        const transport = new StdioClientTransport({
            command,
            args: [...args],
            env: { ...env },
            stderr: "pipe",
        });
        const client = new Client({ name: "agentic-workflow", version: "0.0.1" });
        await client.connect(transport);
        // Without this the server's own diagnostics — including "PERSONAL_ACCESS_TOKEN
        // is not set or empty" — vanish, and an auth failure surfaces only as an
        // opaque JSON-RPC error.
        transport.stderr?.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line)
                log("warn", `ado-mcp: ${line}`);
        });
        return client;
    };
    const connect = opts.connect ?? defaultConnect;
    /**
     * A tool named in `ADO_TOOLS` but missing from the server is the signature of
     * a version bump that renamed the surface — the failure mode that upstream's
     * released-vs-documented mismatch already demonstrated. Log it loudly on
     * connect so the cause is visible, rather than letting each call fail
     * separately with "tool not found".
     */
    const verifyCapabilities = async (client) => {
        try {
            const { tools } = await client.listTools();
            const present = new Set(tools.map((t) => t.name));
            const missing = Object.values(ADO_TOOLS).filter((name) => !present.has(name));
            if (missing.length > 0) {
                log("error", `ado-mcp: server is missing expected tools (${missing.join(", ")}) — the pinned ` +
                    `@azure-devops/mcp version may have changed its tool surface; regenerate ` +
                    `docs/design/ado-mcp-toolsurface.md and reconcile ado-tools.ts`);
            }
        }
        catch (err) {
            log("warn", `ado-mcp: could not list tools for capability check — ${err.message}`);
        }
    };
    const ensure = () => {
        if (session)
            return session;
        const pending = connect().then(async (client) => {
            await verifyCapabilities(client);
            return client;
        });
        session = pending;
        pending.catch(() => {
            // Drop the rejected promise so the next call can retry rather than
            // re-awaiting a permanently failed connect.
            if (session === pending)
                session = null;
            lastFailureAt = now();
        });
        return pending;
    };
    const call = async (tool, toolArgs) => {
        if (closed)
            return { ok: false, error: "azure-devops MCP gateway is closed" };
        if (!session && lastFailureAt > 0 && now() - lastFailureAt < cooldownMs) {
            return {
                ok: false,
                error: `azure-devops MCP server unavailable — retrying in ${Math.ceil((cooldownMs - (now() - lastFailureAt)) / 1000)}s`,
            };
        }
        try {
            const client = await ensure();
            const raw = await client.callTool({ name: tool, arguments: defined(toolArgs) }, undefined, { timeout });
            return unwrapAdoResult(raw);
        }
        catch (err) {
            // A call failure can mean a dead child, so drop the session and let the
            // next call past the cooldown reconnect.
            session = null;
            lastFailureAt = now();
            return { ok: false, error: `azure-devops MCP call ${tool} failed — ${err.message}` };
        }
    };
    return {
        getPullRequest: (a) => call(ADO_TOOLS.getPr, { ...a }),
        listPullRequests: (a) => call(ADO_TOOLS.listPrs, { ...a }),
        listPullRequestsByCommits: (a) => call(ADO_TOOLS.listPrsByCommits, { ...a, commits: [...a.commits] }),
        listPullRequestThreads: (a) => call(ADO_TOOLS.listThreads, { ...a, fullResponse: true }),
        getRepository: (a) => call(ADO_TOOLS.getRepo, { ...a }),
        listBuilds: (a) => call(ADO_TOOLS.getBuilds, { ...a, queryOrder: "queueTimeDescending" }),
        getBuildStatus: (a) => call(ADO_TOOLS.getBuildStatus, { ...a }),
        createPullRequest: (a) => call(ADO_TOOLS.createPr, { ...a }),
        close: async () => {
            closed = true;
            const pending = session;
            session = null;
            if (!pending)
                return;
            try {
                const client = await pending;
                await client.close();
            }
            catch {
                // Already dead, or never connected — nothing to shut down.
            }
        },
    };
};
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
export const adoGatewayFromConfig = (config, log, env = process.env) => {
    if (!config.ado)
        return undefined;
    const spawn = adoMcpSpawn(config.ado, env);
    if (!spawn.ok) {
        void log("warn", `ado-mcp: ${spawn.error}`);
        return undefined;
    }
    return makeAdoMcpGateway({ command: spawn.command, args: spawn.args, env: spawn.env, log });
};
/**
 * The process-wide gateway. Both hosts reload config on nearly every command, so
 * building a gateway per call would spawn a server per call — `sharedAdoGateway`
 * keeps one alive and rebuilds only when the `ado` section actually changes,
 * closing the superseded server so it does not linger.
 */
let shared;
export const sharedAdoGateway = (config, log, env = process.env) => {
    const key = JSON.stringify(config.ado ?? null);
    if (shared?.key === key)
        return shared.gateway;
    const previous = shared;
    shared = undefined;
    if (previous)
        void previous.gateway.close();
    const gateway = adoGatewayFromConfig(config, log, env);
    if (gateway)
        shared = { key, gateway };
    return gateway;
};
/** Shut the shared gateway down — for host teardown. Safe when none was built. */
export const closeSharedAdoGateway = async () => {
    const previous = shared;
    shared = undefined;
    if (previous)
        await previous.gateway.close();
};
