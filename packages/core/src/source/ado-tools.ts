/**
 * The Azure DevOps MCP tool vocabulary — the single source of truth for tool
 * names, shared by the gateway adapter, the write backstop, `gen-prompts.mjs`,
 * and the prompt-assertion tests.
 *
 * Every name here was dumped from a running server rather than read from docs:
 * `tools/list` against `npx -y @azure-devops/mcp@2.8.1 <org> -d repositories
 * -d pipelines`, recorded verbatim in `docs/design/ado-mcp-toolsurface.md`.
 * That mattered — upstream's `docs/TOOLSET.md` on `main` documents a
 * CONSOLIDATED surface (`repo_pull_request` plus an `action` argument) that no
 * released version ships. Planning against the doc would have produced prompts
 * naming tools that do not exist, failing at runtime as "tool not found".
 *
 * So: the version is PINNED, and a bump means regenerating that dump and
 * diffing it before touching anything here. `listTools()` needs no credential
 * (it precedes Azure auth), so re-verifying is cheap.
 */

/**
 * The MCP server name the loop requires, deliberately a constant rather than a
 * config knob: tool names are baked into generated agent frontmatter, and a
 * user-specific name would make those generated files user-specific too,
 * breaking the `gen:prompts && git diff --exit-code` drift gate.
 */
export const ADO_MCP_SERVER_NAME = "azure-devops"

/** Pinned — see the file header. Never `@latest`. */
export const ADO_MCP_PACKAGE = "@azure-devops/mcp@2.8.1"

/** Only the tool domains the loop actually uses are loaded, so the model sees a smaller menu. */
export const ADO_MCP_DOMAINS = ["repositories", "pipelines"] as const

/**
 * Note the argument spellings differ per tool — `repo_list_pull_requests_by_commits`
 * takes `repository`, every other repo tool takes `repositoryId`. That
 * inconsistency is upstream's, and is exactly why the dump is committed.
 */
export const ADO_TOOLS = {
  getPr: "repo_get_pull_request_by_id",
  listPrs: "repo_list_pull_requests_by_repo_or_project",
  listPrsByCommits: "repo_list_pull_requests_by_commits",
  listThreads: "repo_list_pull_request_threads",
  listThreadComments: "repo_list_pull_request_thread_comments",
  getRepo: "repo_get_repo_by_name_or_id",
  createPr: "repo_create_pull_request",
  createThread: "repo_create_pull_request_thread",
  replyToComment: "repo_reply_to_comment",
  getBuilds: "pipelines_get_builds",
  getBuildStatus: "pipelines_get_build_status",
  getBuildLog: "pipelines_get_build_log",
  getBuildLogById: "pipelines_get_build_log_by_id",
} as const

export type AdoToolName = (typeof ADO_TOOLS)[keyof typeof ADO_TOOLS]

/**
 * The only Azure DevOps writes any stage may make. Everything mutating that is
 * absent from this list — voting, completing, abandoning, changing reviewers,
 * queueing pipelines, creating branches — stays a human call.
 */
export const ADO_WRITE_TOOLS: readonly string[] = [
  ADO_TOOLS.createPr,
  ADO_TOOLS.createThread,
  ADO_TOOLS.replyToComment,
]

/** Reads the loop is allowed to perform. */
export const ADO_READ_TOOLS: readonly string[] = [
  ADO_TOOLS.getPr,
  ADO_TOOLS.listPrs,
  ADO_TOOLS.listPrsByCommits,
  ADO_TOOLS.listThreads,
  ADO_TOOLS.listThreadComments,
  ADO_TOOLS.getRepo,
  ADO_TOOLS.getBuilds,
  ADO_TOOLS.getBuildStatus,
  ADO_TOOLS.getBuildLog,
  ADO_TOOLS.getBuildLogById,
]

/** The host-visible tool name a stage agent calls, e.g. `mcp__azure-devops__repo_get_pull_request_by_id`. */
export const adoMcpToolName = (tool: string): string => `mcp__${ADO_MCP_SERVER_NAME}__${tool}`

/**
 * Split a host tool name back into `{ server, tool }`, or `null` when it is not
 * an MCP tool call at all. Kept wide on the server half on purpose: a user may
 * register their own Azure DevOps server under a different name, and the
 * backstop should still recognize it as ADO-reaching.
 */
export const parseMcpToolName = (toolName: string): { server: string; tool: string } | null => {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (!m?.[1] || !m[2]) return null
  return { server: m[1], tool: m[2] }
}
