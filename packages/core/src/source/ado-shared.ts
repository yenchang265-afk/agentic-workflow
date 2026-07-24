import { z } from "zod"

/**
 * The pure Azure DevOps normalizers shared by the `ado-pr.ts` /
 * `ado-ci-runs.ts` work sources and the ship gate, all of which reach Azure
 * DevOps through the `az` CLI (see `ado-az.ts`). The raw ADO REST
 * `GitPullRequest` / `Build` shapes, identifier semantics, and thread-comment
 * flattening live here so each source stays a thin transport over these pure
 * functions.
 *
 * These are REST *response* schemas even though nothing here speaks HTTP:
 * `az devops invoke` is a raw REST passthrough that returns the same JSON
 * envelopes (`{ value: [...] }` wrappers included) the service would, so the
 * parsing is identical either way.
 */

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
