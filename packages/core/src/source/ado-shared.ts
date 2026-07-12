import { z } from "zod"

/**
 * The pure Azure DevOps normalizers for the `ado-pr.ts` work source, which
 * reaches Azure DevOps over its REST API (PAT auth). The raw ADO REST
 * `GitPullRequest` shape, identifier semantics, and thread-comment flattening
 * live here so the source stays a thin transport over these pure functions.
 */

/** The env var holding a JSON object of extra headers to send on every ADO REST call. */
export const ADO_HEADERS_ENV = "AGENTIC_LOOP_ADO_HEADERS"

/**
 * Parse the `AGENTIC_LOOP_ADO_HEADERS` value: a JSON object of string→string
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
 * PAT: config `ado.customHeaders` is the base, and `AGENTIC_LOOP_ADO_HEADERS`
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
  reviewers: z.array(z.object({ vote: z.number().default(0) })).nullish(),
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
