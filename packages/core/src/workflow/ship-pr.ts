import { z } from "zod"
import type { Log, Shell } from "../host.js"
import { platformFor } from "../config.js"
import { execAz, type AzExec } from "../source/ado-az.js"
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
  // No `--json`/`-q` here: those are `gh pr view`/`gh pr list` flags. `gh pr create`
  // rejects them ("unknown flag: --json") and prints the new PR's URL on stdout.
  const out = await $`gh pr create --draft --head ${branch} --base ${base} --title ${title} --body ${""}`
    .cwd(directory)
    .quiet()
    .nothrow()
  const url = out.stdout.toString().trim()
  if (out.exitCode === 0 && url) return { attempted: true, created: true, url }
  const reason = out.stderr.toString().trim() || "gh pr create failed"
  await log("warn", `ship: gh pr create failed for ${branch} — ${reason}`)
  return { attempted: true, created: false, reason }
}

// --- Azure DevOps (REST; PAT or az-minted Bearer auth — mirrors source/ado-pr.ts) ---

/** ADO response shapes, validated — a type-confused body (string pullRequestId,
 *  numeric defaultBranch) must degrade to the same fallbacks as a parse failure,
 *  never flow onward as a trusted value. */
const AdoDefaultBranchSchema = z.object({ defaultBranch: z.string().optional() })
const AdoPrRefSchema = z.object({ pullRequestId: z.number().int().positive().optional() })
const AdoPrArraySchema = z.array(AdoPrRefSchema)

/**
 * The ship gate over the az CLI: `repos show` for the default branch,
 * `repos pr list` for reuse, `repos pr create --draft` to open. The CLI carries
 * its own auth, so nothing here handles the PAT.
 */
const shipAdo = async (
  $: Shell,
  log: Log,
  directory: string,
  az: AzExec,
  config: Config,
  branch: string,
  title: string,
): Promise<ShipPrResult> => {
  const ado = config.ado
  if (!ado) return { attempted: true, created: false, reason: "ado config missing" }
  if (!ado.repository) return { attempted: true, created: false, reason: "ado.repository not configured (required to open a PR)" }
  const org = ado.organization.replace(/\/+$/, "")
  const repo = ado.repository as string
  const scope = ["--organization", org, "--project", ado.project, "--repository", repo, "--output", "json"]
  const prUrl = (id: number): string => `${org}/${ado.project}/_git/${repo}/pullrequest/${id}`

  const existing = await az(["repos", "pr", "list", "--source-branch", branch, "--status", "active", ...scope])
  if (existing.ok) {
    try {
      // Native az verbs return the bare array (no { value } envelope).
      const prs = AdoPrArraySchema.parse(JSON.parse(existing.body || "[]"))
      const id = prs[0]?.pullRequestId
      if (id) return { attempted: true, created: false, url: prUrl(id) }
    } catch {
      /* fall through to create — a malformed list must not block shipping */
    }
  }

  const repoOut = await az(["repos", "show", "--organization", org, "--project", ado.project, "--repository", repo, "--output", "json"])
  let base: string | null = null
  if (repoOut.ok) {
    try {
      const data = AdoDefaultBranchSchema.parse(JSON.parse(repoOut.body || "{}"))
      base = data.defaultBranch ? data.defaultBranch.replace(/^refs\/heads\//, "") : null
    } catch {
      base = null
    }
  }
  base = base ?? (await currentBranch($, directory)) ?? "main"

  const createOut = await az([
    "repos", "pr", "create", "--draft",
    "--source-branch", branch,
    "--target-branch", base,
    "--title", title,
    ...scope,
  ])
  if (!createOut.ok) {
    const reason = `ADO PR create failed (az CLI) — ${createOut.statusText}`
    await log("warn", `ship: ${reason} (${branch})`)
    return { attempted: true, created: false, reason }
  }
  try {
    const data = AdoPrRefSchema.parse(JSON.parse(createOut.body || "{}"))
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
  az: AzExec = execAz,
): Promise<ShipPrResult> => {
  try {
    const branch = `feature/${id}`
    if (!(await branchExists($, directory, branch))) return NOT_ATTEMPTED
    if (!(await pushBranch($, directory, branch))) {
      await log("warn", `ship: git push failed for ${branch}`)
      return { attempted: true, created: false, reason: "git push failed" }
    }
    const platform = platformFor(config, kind)
    return platform === "ado" ? await shipAdo($, log, directory, az, config, branch, title) : await shipGithub($, log, directory, branch, title)
  } catch (err) {
    return { attempted: true, created: false, reason: (err as Error).message }
  }
}
