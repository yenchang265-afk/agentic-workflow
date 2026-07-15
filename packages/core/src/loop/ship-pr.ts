import type { Log, Shell } from "../host.js"
import { platformFor } from "../config.js"
import { ADO_HEADERS_ENV, adoFetch, buildAdoHeaders, resolveAdoHeaders } from "../source/ado-shared.js"
import type { Config } from "./state.js"
import { branchExists, currentBranch, pushBranch } from "./git.js"

/**
 * Push a ship-gated task's branch and open (or reuse) a draft PR for it —
 * GitHub or Azure DevOps, chosen by `platformFor(config, kind)`. Called only
 * from the ship gate, after the task has already been moved to `completed/`:
 * this never throws, and a failure here must never look like the ship itself
 * failed — callers surface `reason` as an audit note, nothing more.
 */

export interface ShipPrResult {
  /** False when there's no `feature/<id>` branch to ship (e.g. a manually authored task) — a silent no-op. */
  readonly attempted: boolean
  /** True only when a new PR was opened this call; a reused existing PR still carries `url` with `created: false`. */
  readonly created: boolean
  readonly url?: string
  readonly reason?: string
}

const NOT_ATTEMPTED: ShipPrResult = { attempted: false, created: false }

/** Minimal HTTP response shape this module reads — structurally satisfied by the global `fetch` `Response`. */
export interface ShipHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

/** POST-capable HTTP transport, injected so tests can script responses without touching the network. */
export type ShipHttp = (
  url: string,
  init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<ShipHttpResponse>

// --- GitHub (via `gh`) ---

const ghExistingPrUrl = async ($: Shell, cwd: string, branch: string): Promise<string | null> => {
  const out = await $`gh pr view ${branch} --json url -q .url`.cwd(cwd).quiet().nothrow()
  const url = out.stdout.toString().trim()
  return out.exitCode === 0 && url ? url : null
}

const ghDefaultBranch = async ($: Shell, cwd: string): Promise<string | null> => {
  const out = await $`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.cwd(cwd).quiet().nothrow()
  const name = out.stdout.toString().trim()
  return out.exitCode === 0 && name ? name : null
}

const shipGithub = async ($: Shell, log: Log, directory: string, branch: string, title: string): Promise<ShipPrResult> => {
  const existing = await ghExistingPrUrl($, directory, branch)
  if (existing) return { attempted: true, created: false, url: existing }
  const base = (await ghDefaultBranch($, directory)) ?? (await currentBranch($, directory)) ?? "main"
  const out = await $`gh pr create --draft --head ${branch} --base ${base} --title ${title} --body ${""} --json url -q .url`
    .cwd(directory)
    .quiet()
    .nothrow()
  const url = out.stdout.toString().trim()
  if (out.exitCode === 0 && url) return { attempted: true, created: true, url }
  const reason = out.stderr.toString().trim() || "gh pr create failed"
  await log("warn", `ship: gh pr create failed for ${branch} — ${reason}`)
  return { attempted: true, created: false, reason }
}

// --- Azure DevOps (REST, PAT auth — mirrors source/ado-pr.ts's auth) ---

const PAT_ENV = "AZURE_DEVOPS_EXT_PAT"
const API_VERSION = "api-version=7.1"

/** One authenticated call. Never throws — a network error reads as a non-ok response. */
const adoCall = async (
  http: ShipHttp,
  url: string,
  authHeader: string,
  method: "GET" | "POST",
  customHeaders: Readonly<Record<string, string>>,
  body?: string,
): Promise<{ ok: boolean; status: number; statusText: string; body: string }> => {
  try {
    const base: Record<string, string> = { Authorization: authHeader, Accept: "application/json" }
    if (body !== undefined) base["Content-Type"] = "application/json"
    const res = await http(url, { method, headers: buildAdoHeaders(base, customHeaders), body })
    return { ok: res.ok, status: res.status, statusText: res.statusText, body: await res.text().catch(() => "") }
  } catch (err) {
    return { ok: false, status: 0, statusText: (err as Error).message, body: "" }
  }
}

/** The repo's default branch (`refs/heads/x` stripped), or null on any failure. */
const adoDefaultBranch = async (
  http: ShipHttp,
  repoBase: string,
  authHeader: string,
  customHeaders: Readonly<Record<string, string>>,
): Promise<string | null> => {
  const out = await adoCall(http, `${repoBase}?${API_VERSION}`, authHeader, "GET", customHeaders)
  if (!out.ok) return null
  try {
    const data = JSON.parse(out.body || "{}") as { defaultBranch?: string }
    return data.defaultBranch ? data.defaultBranch.replace(/^refs\/heads\//, "") : null
  } catch {
    return null
  }
}

/** The first active PR's id for `branch`, or null when none exists. */
const adoExistingPrId = async (
  http: ShipHttp,
  repoBase: string,
  branch: string,
  authHeader: string,
  customHeaders: Readonly<Record<string, string>>,
): Promise<number | null> => {
  const url = `${repoBase}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=active&${API_VERSION}`
  const out = await adoCall(http, url, authHeader, "GET", customHeaders)
  if (!out.ok) return null
  try {
    const data = JSON.parse(out.body || "{}") as { value?: Array<{ pullRequestId?: number }> }
    return data.value?.[0]?.pullRequestId ?? null
  } catch {
    return null
  }
}

const shipAdo = async (
  $: Shell,
  log: Log,
  directory: string,
  http: ShipHttp,
  config: Config,
  branch: string,
  title: string,
): Promise<ShipPrResult> => {
  const ado = config.ado
  if (!ado) return { attempted: true, created: false, reason: "ado config missing" }
  if (!ado.repository) return { attempted: true, created: false, reason: "ado.repository not configured (required to open a PR)" }
  const pat = process.env[PAT_ENV] ?? ado.pat ?? ""
  if (!pat) return { attempted: true, created: false, reason: `${PAT_ENV} not set` }

  const org = ado.organization.replace(/\/+$/, "")
  const project = encodeURIComponent(ado.project)
  const repo = encodeURIComponent(ado.repository)
  const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`
  const repoBase = `${org}/${project}/_apis/git/repositories/${repo}`
  const prUrl = (id: number): string => `${org}/${ado.project}/_git/${ado.repository}/pullrequest/${id}`
  // Config headers as a base, env `AGENTIC_LOOP_ADO_HEADERS` overriding (env wins, like the PAT).
  const customHeaders = resolveAdoHeaders(ado.customHeaders, process.env[ADO_HEADERS_ENV])

  const existingId = await adoExistingPrId(http, repoBase, branch, authHeader, customHeaders)
  if (existingId) return { attempted: true, created: false, url: prUrl(existingId) }

  const base = (await adoDefaultBranch(http, repoBase, authHeader, customHeaders)) ?? (await currentBranch($, directory)) ?? "main"
  const createOut = await adoCall(
    http,
    `${repoBase}/pullrequests?${API_VERSION}`,
    authHeader,
    "POST",
    customHeaders,
    JSON.stringify({ sourceRefName: `refs/heads/${branch}`, targetRefName: `refs/heads/${base}`, title, isDraft: true }),
  )
  if (!createOut.ok) {
    const reason = `ADO PR create failed — HTTP ${createOut.status} ${createOut.statusText}`
    await log("warn", `ship: ${reason} (${branch})`)
    return { attempted: true, created: false, reason }
  }
  try {
    const data = JSON.parse(createOut.body || "{}") as { pullRequestId?: number }
    if (!data.pullRequestId) return { attempted: true, created: false, reason: "ADO PR create: no pullRequestId in response" }
    return { attempted: true, created: true, url: prUrl(data.pullRequestId) }
  } catch (err) {
    return { attempted: true, created: false, reason: `ADO PR create: could not parse response — ${(err as Error).message}` }
  }
}

/**
 * Ship a task's branch: push `feature/<id>` and open (or reuse) a draft PR.
 * `kind` resolves the platform via `platformFor` — the `<tasksDir>` file
 * backlog is always the `"engineering"` kind. Never throws.
 */
export const shipPr = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  kind: string,
  id: string,
  title: string,
  http: ShipHttp = adoFetch(config.ado?.insecureSkipTlsVerify),
): Promise<ShipPrResult> => {
  try {
    const branch = `feature/${id}`
    if (!(await branchExists($, directory, branch))) return NOT_ATTEMPTED
    if (!(await pushBranch($, directory, branch))) {
      await log("warn", `ship: git push failed for ${branch}`)
      return { attempted: true, created: false, reason: "git push failed" }
    }
    const platform = platformFor(config, kind)
    return platform === "ado" ? await shipAdo($, log, directory, http, config, branch, title) : await shipGithub($, log, directory, branch, title)
  } catch (err) {
    return { attempted: true, created: false, reason: (err as Error).message }
  }
}
