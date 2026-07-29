import { z } from "zod"
import type { AdoConfig } from "../workflow/state.js"
import { ADO_MCP_DOMAINS, ADO_MCP_PACKAGE } from "./ado-tools.js"

/**
 * The pure Azure DevOps helpers shared by the `ado-pr.ts` / `ado-ci-runs.ts`
 * work sources and the ship gate. Azure DevOps is reached ONLY through the
 * Azure DevOps MCP server (`@agentic-workflow/ado-mcp` satisfies the
 * `AdoGateway` port); this module owns the spawn spec, the response schemas,
 * and the normalizers, so each source stays a thin shell over pure functions.
 */

/** The env var holding the Azure DevOps PAT — the name the `az` extension used, kept for continuity. */
export const ADO_PAT_ENV = "AZURE_DEVOPS_EXT_PAT"

/**
 * The value the MCP server's `-a pat` mode expects in `PERSONAL_ACCESS_TOKEN`.
 *
 * The server base64-decodes it, splits on ":" and keeps everything AFTER the
 * first colon (`@azure-devops/mcp` `dist/index.js`), so the username half is
 * discarded and an empty one is correct — this needs no identity, unlike the
 * reviewer-role filter which still needs `ado.selfLogin`. The colon is NOT
 * optional: a base64 value without one decodes to an empty token and the server
 * fails with an opaque auth error. Pure.
 */
export const adoMcpPatToken = (pat: string): string => Buffer.from(`:${pat}`).toString("base64")

/**
 * The organization NAME the MCP server takes as its positional argument, from
 * the configured organization URL — `https://dev.azure.com/acme` → `acme`,
 * `https://acme.visualstudio.com` → `acme`. Returns "" when neither form
 * matches, which callers report rather than guessing. Pure.
 */
export const adoOrgName = (organizationUrl: string): string => {
  let url: URL
  try {
    url = new URL(organizationUrl)
  } catch {
    return ""
  }
  const segments = url.pathname.split("/").filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) return last
  // `<org>.visualstudio.com` carries the org in the host instead of the path.
  const [label] = url.hostname.split(".")
  return label && url.hostname.endsWith(".visualstudio.com") ? label : ""
}

/** How the Azure DevOps MCP server should be launched, or why it can't be. */
export type AdoMcpSpawn =
  | { readonly ok: true; readonly command: string; readonly args: string[]; readonly env: Record<string, string> }
  | { readonly ok: false; readonly error: string }

/**
 * Build the spawn spec for the Azure DevOps MCP server. Pure over its inputs —
 * callers pass `process.env` rather than this reading it — so the arg vector and
 * the child environment are both testable without spawning anything.
 *
 * PAT precedence mirrors the old REST path: `AZURE_DEVOPS_EXT_PAT` wins over
 * config `ado.pat`.
 */
export const adoMcpSpawn = (ado: AdoConfig, env: Readonly<Record<string, string | undefined>>): AdoMcpSpawn => {
  const org = adoOrgName(ado.organization)
  if (!org) {
    return { ok: false, error: `could not read an organization name from ado.organization ("${ado.organization}")` }
  }

  const mcp = ado.mcp ?? {}
  const authentication = mcp.authentication ?? "pat"
  const domains = mcp.domains ?? [...ADO_MCP_DOMAINS]

  // The server defaults to `interactive`, which opens a browser. A poller has
  // no one to click it, so refuse loudly here instead of hanging on a prompt
  // nobody sees. Allowed when a human is actually at a terminal.
  if (authentication === "interactive" && !env["ADO_MCP_ALLOW_INTERACTIVE"]) {
    return {
      ok: false,
      error:
        "ado.mcp.authentication 'interactive' opens a browser and cannot work in a polling loop — " +
        `use "pat" with ${ADO_PAT_ENV} (or ado.pat), or "azcli" after an 'az login'`,
    }
  }

  const childEnv: Record<string, string> = { ...(mcp.env ?? {}) }
  if (authentication === "pat") {
    const pat = env[ADO_PAT_ENV] ?? ado.pat ?? ""
    if (!pat) {
      return { ok: false, error: `no Azure DevOps credential: set ${ADO_PAT_ENV} (or ado.pat) with a token that can read code` }
    }
    childEnv["PERSONAL_ACCESS_TOKEN"] = adoMcpPatToken(pat)
  } else if (authentication === "envvar") {
    const bearer = env["ADO_MCP_AUTH_TOKEN"] ?? ""
    if (!bearer) {
      return { ok: false, error: "ado.mcp.authentication 'envvar' requires ADO_MCP_AUTH_TOKEN to hold a bearer token" }
    }
    childEnv["ADO_MCP_AUTH_TOKEN"] = bearer
  }

  const args = [...(mcp.args ?? ["-y", ADO_MCP_PACKAGE]), org]
  for (const domain of domains) args.push("-d", domain)
  args.push("-a", authentication)
  if (mcp.tenant) args.push("-t", mcp.tenant)

  return { ok: true, command: mcp.command ?? "npx", args, env: childEnv }
}

/**
 * Read a list payload from an MCP tool result.
 *
 * Deliberately tolerant of both shapes. Azure DevOps REST wraps collections in
 * `{ value: [...] }`, but the MCP server returns whatever `azure-devops-node-api`
 * hands back, and that library already unwraps `value` into a bare array. Rather
 * than bet on one, accept either — the cost is three lines and the failure it
 * prevents (every poll parsing to zero items, reported as "nothing needs
 * attention") is silent. Pure.
 */
export const adoList = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data
  if (data && typeof data === "object") {
    const value = (data as { value?: unknown }).value
    if (Array.isArray(value)) return value
  }
  return []
}

/** `refs/heads/x` → `x`. */
export const stripRef = (ref: string): string => ref.replace(/^refs\/heads\//, "")

/** ADO logins are emails — case-insensitive identifiers. */
export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * `a` strictly newer than `b`. ADO timestamps carry variable-precision
 * fractional seconds ("…20.9Z" vs "…20.873Z"), which string comparison
 * misorders — compare parsed times, falling back to strings when unparsable.
 */
export const newerThan = (a: string, b: string): boolean => {
  if (!b) return Boolean(a)
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb
}

/**
 * The `GitPullRequest` fields both sources read.
 *
 * `createdBy` and `reviewers` are REQUIRED, not `.nullish()`, on purpose: they
 * are what the role filter and the fork skip judge, and a payload trimmed of
 * them would silently claim nothing (author role) or claim everything
 * (reviewer role) rather than fail. A loud parse error is the correct outcome.
 */
export const AdoPrFieldsSchema = z.object({
  pullRequestId: z.number().int().positive(),
  title: z.string(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  isDraft: z.boolean().default(false),
  mergeStatus: z.string().nullish(),
  createdBy: z.object({ uniqueName: z.string().default("") }),
  lastMergeSourceCommit: z.object({ commitId: z.string().default("") }).nullish(),
  reviewers: z.array(
    z.object({
      vote: z.number().default(0),
      uniqueName: z.string().default(""),
      isRequired: z.boolean().default(false),
    }),
  ),
  /** Present when the PR comes from a fork — same skip rule as GitHub's `isCrossRepository`. */
  forkSource: z.unknown().nullish(),
  repository: z
    .object({
      id: z.string().default(""),
      name: z.string().default(""),
      project: z.object({ id: z.string().default("") }).nullish(),
    })
    .nullish(),
})

export const AdoPrListSchema = z.array(AdoPrFieldsSchema)

/** One PR comment thread. */
export const AdoThreadSchema = z.object({
  isDeleted: z.boolean().default(false),
  comments: z
    .array(
      z.object({
        commentType: z.string().nullish(),
        publishedDate: z.string().nullish(),
        isDeleted: z.boolean().default(false),
        author: z.object({ uniqueName: z.string().default("") }).nullish(),
      }),
    )
    .nullish(),
})
export type AdoThread = z.infer<typeof AdoThreadSchema>

export const AdoThreadListSchema = z.array(AdoThreadSchema)

/** Non-system, non-deleted thread comments flattened to `{ author, at }`. Pure. */
export const flattenThreadComments = (threads: readonly AdoThread[]): { author: string; at: string }[] =>
  threads
    .filter((t) => !t.isDeleted)
    .flatMap((t) => t.comments ?? [])
    .filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system" && c.publishedDate)
    .map((c) => ({ author: c.author?.uniqueName ?? "", at: c.publishedDate ?? "" }))

/** One `Build` resource off the builds list. */
export const AdoBuildSchema = z.object({
  sourceVersion: z.string().default(""),
  /** ADO build status: "completed" once finished, else "notStarted"/"inProgress"/etc. */
  status: z.string().default(""),
  /** Set only once `status` is "completed": "succeeded" | "partiallySucceeded" | "failed" | "canceled". */
  result: z.string().nullish(),
  definition: z.object({ name: z.string().default("") }).nullish(),
  queueTime: z.string().default(""),
  startTime: z.string().nullish(),
  finishTime: z.string().nullish(),
})
export type AdoBuild = z.infer<typeof AdoBuildSchema>

export const AdoBuildListSchema = z.array(AdoBuildSchema)

/** ADO `result` → the conclusion vocabulary `ci-runs.ts`'s FAILING set judges against. Pure. */
const BUILD_RESULT_TO_CONCLUSION: Readonly<Record<string, string>> = {
  succeeded: "success",
  failed: "failure",
  // A partial success still means something broke — judged as failing, same
  // conservatism as treating it as red rather than silently green.
  partiallysucceeded: "failure",
}

/** One normalized run, in the shape `ci-runs.ts`'s `newestHeadVerdict` judges — kept structural (not imported) to avoid a cross-source type dependency. */
export interface NormalizedRun {
  readonly headSha: string
  readonly status: string
  readonly conclusion: string | null
  readonly workflowName: string
  readonly createdAt: string
}

/**
 * Normalize one ADO build into the exact shape the GitHub `ci-runs` source
 * produces, so the shared, already-tested `newestHeadVerdict` judges both
 * platforms identically. A `canceled` result maps to no conclusion at all
 * (neither failing nor a green signal) — a manual cancellation isn't a code
 * breakage the diagnose stage should chase. Pure.
 */
export const normalizeAdoBuild = (b: AdoBuild): NormalizedRun => ({
  headSha: b.sourceVersion,
  status: b.status,
  conclusion: b.result ? (BUILD_RESULT_TO_CONCLUSION[b.result.toLowerCase()] ?? null) : null,
  workflowName: b.definition?.name ?? "",
  createdAt: b.queueTime || b.startTime || b.finishTime || "",
})

/**
 * Names of pipeline definitions whose NEWEST run is failing — the PR-level
 * equivalent of GitHub's failing checks.
 *
 * This replaced a `policy/evaluations` call, and the semantics genuinely
 * narrowed: it covers build validation only. Blocking branch policies that are
 * not pipelines — minimum reviewers, comment resolution, required work-item
 * links, third-party status checks — are invisible to the Azure DevOps MCP
 * server, which exposes no policy tool at all. A PR blocked solely by one of
 * those no longer raises a `failing-checks` trigger.
 *
 * Newest-per-definition matters: a definition that failed and was then re-run
 * green must not keep reporting, so every run is considered, not just the
 * failures. Pure.
 */
export const failingPipelineNames = (builds: readonly AdoBuild[]): string[] => {
  const newest = new Map<string, AdoBuild>()
  for (const build of builds) {
    const name = build.definition?.name ?? ""
    if (!name) continue
    const seen = newest.get(name)
    if (!seen || newerThan(build.queueTime, seen.queueTime)) newest.set(name, build)
  }
  return [...newest.entries()]
    .filter(([, b]) => b.status.toLowerCase() === "completed" && normalizeAdoBuild(b).conclusion === "failure")
    .map(([name]) => name)
}
