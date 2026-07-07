import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { AdoConfig } from "../loop/state.js";
import type { WorkSource } from "./types.js";
/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored
 * onto the `az` CLI (`azure-devops` extension). Selected at wiring time when
 * config `codePlatform` resolves to `"ado"` for a `github-pr`-bound loop kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 * Auth is delegated to the CLI (`az devops login` / `AZURE_DEVOPS_EXT_PAT`);
 * unlike GitHub's `statusCheckRollup`, check state comes from a per-PR
 * `az repos pr policy list` call, and comments from the pullRequestThreads
 * REST resource via `az devops invoke`.
 */
interface AdoPrDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly tasksDir: string;
    readonly log: Log;
    readonly loaded: LoadedManifest;
    /** Azure DevOps coordinates (config `ado`). */
    readonly ado: AdoConfig;
    /** Clock injection for ledger stamps; defaults to the real time. */
    readonly now?: () => string;
}
export declare const makeAdoPrSource: (deps: AdoPrDeps) => WorkSource;
export {};
