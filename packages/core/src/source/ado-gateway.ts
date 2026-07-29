/**
 * The Azure DevOps port. Core codes against this; the MCP client that satisfies
 * it lives in `@agentic-workflow/ado-mcp`, which is the only place in the repo
 * importing `@modelcontextprotocol/sdk` as a CLIENT.
 *
 * Why a narrow set of named operations rather than a generic
 * `callTool(name, args)`:
 *
 * - A generic port would put tool names and argument spellings in two places
 *   (core's call sites AND the adapter). Keeping them in one place is the whole
 *   reason `ado-tools.ts` exists — upstream spells `repositoryId` on every repo
 *   tool except `repo_list_pull_requests_by_commits`, which spells it
 *   `repository`, and that kind of trap should be encoded once.
 * - It keeps `host.ts`'s invariant literally true: this module is types only,
 *   so nothing in core imports a host SDK.
 * - Tests fake it with a plain object literal — no MCP vocabulary leaks into
 *   `ado-pr.test.ts`.
 *
 * `createPullRequest` is deliberately the ONLY write here. The driver never
 * posts comments or votes; only stage agents do, through their own host's MCP
 * client, where the write backstop can see the call. A write-poor port means a
 * compromised core call site cannot reach a mutating tool at all.
 */

/**
 * Never-throwing call result. This mirrors the `.nothrow()` shape the REST
 * `get()` helpers had, so every call site's actionable-skip path survives: a
 * failure is data the poller reports and retries next tick, not an exception
 * that takes the scheduler down.
 */
export type AdoResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string }

/** Azure DevOps operations the driver performs. Raw `unknown` payloads — core owns all parsing. */
export interface AdoGateway {
  /** `repo_get_pull_request_by_id` */
  getPullRequest(a: {
    readonly project: string
    readonly repositoryId: string
    readonly pullRequestId: number
  }): Promise<AdoResult>

  /** `repo_list_pull_requests_by_repo_or_project` */
  listPullRequests(a: {
    readonly project: string
    readonly repositoryId?: string
    readonly status?: string
    readonly sourceRefName?: string
    readonly top?: number
    readonly skip?: number
  }): Promise<AdoResult>

  /** `repo_list_pull_requests_by_commits` — note this tool spells it `repository`, not `repositoryId`. */
  listPullRequestsByCommits(a: {
    readonly project: string
    readonly repository: string
    readonly commits: readonly string[]
  }): Promise<AdoResult>

  /** `repo_list_pull_request_threads` */
  listPullRequestThreads(a: {
    readonly project: string
    readonly repositoryId: string
    readonly pullRequestId: number
  }): Promise<AdoResult>

  /** `repo_get_repo_by_name_or_id` — the repository's `defaultBranch`. */
  getRepository(a: { readonly project: string; readonly repositoryNameOrId: string }): Promise<AdoResult>

  /** `pipelines_get_builds` */
  listBuilds(a: {
    readonly project: string
    readonly branchName?: string
    readonly top?: number
  }): Promise<AdoResult>

  /** `pipelines_get_build_status` — only for a build whose list entry lacks a `result`. */
  getBuildStatus(a: { readonly project: string; readonly buildId: number }): Promise<AdoResult>

  /** `repo_create_pull_request` — the only write on this port. `isDraft` is always true for loop-opened PRs. */
  createPullRequest(a: {
    readonly project: string
    readonly repositoryId: string
    readonly sourceRefName: string
    readonly targetRefName: string
    readonly title: string
    readonly description?: string
    readonly isDraft: boolean
  }): Promise<AdoResult>

  /** Shut the server down. Idempotent; safe to call when never connected. */
  close(): Promise<void>
}
