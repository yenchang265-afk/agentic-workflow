import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { WorkSource } from "./types.js";
interface GithubPrDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly tasksDir: string;
    readonly log: Log;
    readonly loaded: LoadedManifest;
    /** Override of the manifest's search query (config `loops.pr-sitter.query`). */
    readonly query?: string;
    /** Clock injection for ledger stamps; defaults to the real time. */
    readonly now?: () => string;
}
export declare const makeGithubPrSource: (deps: GithubPrDeps) => WorkSource;
export {};
