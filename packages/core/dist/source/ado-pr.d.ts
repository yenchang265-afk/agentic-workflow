import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { AdoConfig } from "../loop/state.js";
import type { WorkSource } from "./types.js";
/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored onto
 * the Azure DevOps REST API. Selected at wiring time when config `codePlatform`
 * resolves to `"ado"` for a `github-pr`-bound loop kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 *
 * Auth is a Personal Access Token sent as HTTP Basic (`Authorization: Basic
 * base64(":" + PAT)`), read from `AZURE_DEVOPS_EXT_PAT`. A PAT carries no
 * reliable email identity, so the sitter's own login is config-supplied
 * (`ado.selfLogin`, required for this platform — enforced in `config.ts`).
 * Unlike GitHub's `statusCheckRollup`, check state comes from a per-PR
 * `policy/evaluations` call, and comments from the `pullRequestThreads` resource.
 */
/** Minimal HTTP response the source reads — structurally satisfied by the global `fetch` `Response`. */
export interface AdoHttpResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    text(): Promise<string>;
}
/** GET-only HTTP transport, injected so tests can script responses without touching the network. */
export type AdoHttp = (url: string, init: {
    readonly headers: Readonly<Record<string, string>>;
}) => Promise<AdoHttpResponse>;
interface AdoPrDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly tasksDir: string;
    readonly log: Log;
    readonly loaded: LoadedManifest;
    /** Azure DevOps coordinates (config `ado`); `selfLogin` is required for this platform. */
    readonly ado: AdoConfig;
    /** HTTP transport for ADO REST calls; defaults to the global `fetch`. */
    readonly http?: AdoHttp;
    /** The Personal Access Token; defaults to `process.env.AZURE_DEVOPS_EXT_PAT`. */
    readonly pat?: string;
    /** Clock injection for ledger stamps; defaults to the real time. */
    readonly now?: () => string;
}
export declare const makeAdoPrSource: (deps: AdoPrDeps) => WorkSource;
export {};
