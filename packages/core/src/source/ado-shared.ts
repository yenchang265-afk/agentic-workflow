import { Agent, fetch as undiciFetch } from "undici"
import { z } from "zod"

/**
 * The pure Azure DevOps normalizers for the `ado-pr.ts` work source, which
 * reaches Azure DevOps over its REST API (PAT auth). The raw ADO REST
 * `GitPullRequest` shape, identifier semantics, and thread-comment flattening
 * live here so the source stays a thin transport over these pure functions.
 */

/** The env var holding a JSON object of extra headers to send on every ADO REST call. */
export const ADO_HEADERS_ENV = "AGENTIC_WORKFLOW_ADO_HEADERS"

/**
 * Parse the `AGENTIC_WORKFLOW_ADO_HEADERS` value: a JSON object of string→string
 * header pairs. Anything malformed — not JSON, not an object, or a non-string
 * value — is ignored (→ `{}`) rather than thrown, so a bad env var degrades to
 * "no override" instead of crashing the driver. Empty-string keys are dropped.
 * Pure.
 */
export const parseAdoHeadersEnv = (raw: string | undefined): Record<string, string> => {
  if (!raw?.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(json)) {
    if (key && typeof value === "string") out[key] = value
  }
  return out
}

/**
 * Resolve the effective custom headers with the same env-wins precedence as the
 * PAT: config `ado.customHeaders` is the base, and `AGENTIC_WORKFLOW_ADO_HEADERS`
 * (parsed via {@link parseAdoHeadersEnv}) overrides it key by key. Pure over its
 * inputs — callers pass `process.env[ADO_HEADERS_ENV]`.
 */
export const resolveAdoHeaders = (
  configHeaders: Readonly<Record<string, string>> | undefined,
  env: string | undefined,
): Record<string, string> => ({ ...(configHeaders ?? {}), ...parseAdoHeadersEnv(env) })

/**
 * Merge the built-in per-request headers (Authorization/Accept, plus
 * Content-Type on writes) with the user's custom headers. Custom headers win on
 * a key clash — documented as the user's responsibility. Pure.
 */
export const buildAdoHeaders = (
  base: Readonly<Record<string, string>>,
  custom: Readonly<Record<string, string>> | undefined,
): Record<string, string> => ({ ...base, ...(custom ?? {}) })

/** Minimal HTTP response shape the ADO transports read — structurally satisfied by `fetch`'s `Response`. */
export interface AdoTransportResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

/** Request shape both the GET-only PR/CI-runs sources and the POST-capable ship gate pass through. */
export interface AdoTransportInit {
  readonly method?: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/**
 * A single `undici` `Agent` that skips certificate verification, built lazily
 * (and only once) the first time a config actually opts into
 * `ado.insecureSkipTlsVerify` — the default, verified path never touches this.
 * Shared across calls so insecure ADO requests still pool connections instead
 * of paying a fresh TLS handshake per call.
 */
let insecureDispatcher: Agent | undefined
const getInsecureDispatcher = (): Agent =>
  (insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } }))

/**
 * Build the default transport for ADO REST calls, honoring
 * `ado.insecureSkipTlsVerify`. When set, requests go through a dedicated
 * `undici` dispatcher with certificate verification disabled — scoped to
 * these calls only, unlike the process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * escape hatch, so it never weakens TLS for unrelated requests (GitHub, npm,
 * …) made elsewhere in the same process. Only for a self-hosted Azure DevOps
 * Server behind a self-signed or internal-CA cert; never for the hosted
 * `dev.azure.com` service. Pure given the flag (the dispatcher itself is a
 * cached singleton, not per-call state).
 */
export const adoFetch =
  (insecureSkipTlsVerify: boolean | undefined) =>
  (url: string, init: AdoTransportInit): Promise<AdoTransportResponse> =>
    insecureSkipTlsVerify
      ? undiciFetch(url, { ...init, dispatcher: getInsecureDispatcher() })
      : fetch(url, init)

export interface AdoAuthDeps {
  /** The resolved PAT ("" / undefined when none). */
  readonly pat?: string
}

/**
 * Build the async `Authorization` header producer the driver's ADO REST calls
 * (the PR/CI-runs poll sources and the ship gate) authenticate with. ADO is
 * reached only over REST, which always needs a PAT; without one it fails loud
 * naming both remedies.
 */
export const makeAdoAuthHeader = (deps: AdoAuthDeps): (() => Promise<string>) => {
  const { pat } = deps
  if (pat) return () => Promise.resolve(`Basic ${Buffer.from(`:${pat}`).toString("base64")}`)
  return () =>
    Promise.reject(
      new Error("no Azure DevOps credential: set AZURE_DEVOPS_EXT_PAT (or ado.pat) — ADO REST calls always need a PAT"),
    )
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

/** Blocking-policy statuses that count as a failing check. */
export const POLICY_FAILING = new Set(["rejected", "broken", "failed"])

/** The `GitPullRequest` fields both sources read off the PR list. */
export const AdoPrFieldsSchema = z.object({
  pullRequestId: z.number().int().positive(),
  title: z.string(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  isDraft: z.boolean().default(false),
  mergeStatus: z.string().nullish(),
  createdBy: z.object({ uniqueName: z.string().default("") }).nullish(),
  lastMergeSourceCommit: z.object({ commitId: z.string().default("") }).nullish(),
  reviewers: z
    .array(
      z.object({
        vote: z.number().default(0),
        uniqueName: z.string().default(""),
        isRequired: z.boolean().default(false),
      }),
    )
    .nullish(),
  /** Present when the PR comes from a fork — same skip rule as GitHub's `isCrossRepository`. */
  forkSource: z.unknown().nullish(),
  repository: z
    .object({
      id: z.string().default(""),
      name: z.string().default(""),
      /** Project GUID — needed to build the CodeReview artifact ID for policy evaluations. */
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

/** The `pullRequestThreads` REST resource wraps threads in `{ value: [...] }`. */
export const AdoThreadsSchema = z.object({ value: z.array(AdoThreadSchema).nullish() })

export const AdoPolicySchema = z.array(
  z.object({
    status: z.string().nullish(),
    configuration: z
      .object({
        isBlocking: z.boolean().default(true),
        type: z.object({ displayName: z.string().default("") }).nullish(),
      })
      .nullish(),
  }),
)

/** Non-system, non-deleted thread comments flattened to `{ author, at }`. Pure. */
export const flattenThreadComments = (threads: readonly AdoThread[]): { author: string; at: string }[] =>
  threads
    .filter((t) => !t.isDeleted)
    .flatMap((t) => t.comments ?? [])
    .filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system" && c.publishedDate)
    .map((c) => ({ author: c.author?.uniqueName ?? "", at: c.publishedDate ?? "" }))

/** Names of blocking policies currently failing (ADO's nearest equivalent of failing checks). Pure. */
export const failingPolicyNames = (raw: z.infer<typeof AdoPolicySchema>): string[] =>
  raw
    .filter((p) => p.configuration?.isBlocking !== false) // optional policies don't gate the merge
    .filter((p) => POLICY_FAILING.has((p.status ?? "").toLowerCase()))
    .map((p) => p.configuration?.type?.displayName ?? "")
    .filter(Boolean)

/** One `Build` resource off the `_apis/build/builds` list. */
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
