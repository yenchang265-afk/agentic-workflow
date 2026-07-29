import { z } from "zod"
import type { Log, Shell } from "../host.js"
import { platformFor } from "../config.js"
import { adoList } from "../source/ado-shared.js"
import type { AdoGateway } from "../source/ado-gateway.js"
import type { Config } from "./state.js"
import { branchExists, currentBranch, pushBranch } from "./git.js"

/**
 * Push a ship-gated task's branch and open (or reuse) a draft PR for it —
 * GitHub or Azure DevOps, chosen by `platformFor(config, kind)`. Called only
 * from the ship gate, after the task has already been moved to `completed/`:
 * this never throws, and a failure here must never fail the ship — opening a PR
 * is not a requirement of shipping. It must not be SILENT either: the ship gate
 * renders `reason` onto its `GateResult` as a warning (message + `pr.opened`),
 * not only into the audit note, which is invisible under the default
 * `ignoreBacklog: true` that never commits it.
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

// --- Azure DevOps (via the MCP gateway — mirrors source/ado-pr.ts) ---

/** ADO response shapes, validated — a type-confused payload (string pullRequestId,
 *  numeric defaultBranch) must degrade to the same fallbacks as a parse failure,
 *  never flow onward as a trusted value. */
const AdoDefaultBranchSchema = z.object({ defaultBranch: z.string().optional() })
const AdoPrRefSchema = z.object({ pullRequestId: z.number().int().positive().optional() })

/** The repo's default branch (`refs/heads/x` stripped), or null on any failure. */
const adoDefaultBranch = async (gateway: AdoGateway, project: string, repository: string): Promise<string | null> => {
  const out = await gateway.getRepository({ project, repositoryNameOrId: repository })
  if (!out.ok) return null
  try {
    const data = AdoDefaultBranchSchema.parse(out.data)
    return data.defaultBranch ? data.defaultBranch.replace(/^refs\/heads\//, "") : null
  } catch {
    return null
  }
}

/** The first active PR's id for `branch`, or null when none exists. */
const adoExistingPrId = async (
  gateway: AdoGateway,
  project: string,
  repository: string,
  branch: string,
): Promise<number | null> => {
  const out = await gateway.listPullRequests({
    project,
    repositoryId: repository,
    sourceRefName: `refs/heads/${branch}`,
    status: "active",
    top: 1,
  })
  if (!out.ok) return null
  try {
    const [first] = z.array(AdoPrRefSchema).parse(adoList(out.data))
    return first?.pullRequestId ?? null
  } catch {
    return null
  }
}

const shipAdo = async (
  $: Shell,
  log: Log,
  directory: string,
  gateway: AdoGateway | undefined,
  config: Config,
  branch: string,
  title: string,
): Promise<ShipPrResult> => {
  const ado = config.ado
  if (!ado) return { attempted: true, created: false, reason: "ado config missing" }
  if (!ado.repository) return { attempted: true, created: false, reason: "ado.repository not configured (required to open a PR)" }
  if (!gateway) return { attempted: true, created: false, reason: "no Azure DevOps MCP gateway configured" }

  const org = ado.organization.replace(/\/+$/, "")
  const project = ado.project
  const repository = ado.repository
  const prUrl = (id: number): string => `${org}/${project}/_git/${repository}/pullrequest/${id}`

  const existingId = await adoExistingPrId(gateway, project, repository, branch)
  if (existingId) return { attempted: true, created: false, url: prUrl(existingId) }

  const base = (await adoDefaultBranch(gateway, project, repository)) ?? (await currentBranch($, directory)) ?? "main"
  const createOut = await gateway.createPullRequest({
    project,
    repositoryId: repository,
    sourceRefName: `refs/heads/${branch}`,
    targetRefName: `refs/heads/${base}`,
    title,
    // Never anything but a draft: a loop-opened PR must not look review-ready
    // until a human has looked at it. The write backstop enforces the same rule
    // on the stage agents.
    isDraft: true,
  })
  if (!createOut.ok) {
    const reason = `ADO PR create failed — ${createOut.error}`
    await log("warn", `ship: ${reason} (${branch})`)
    return { attempted: true, created: false, reason }
  }
  try {
    const data = AdoPrRefSchema.parse(createOut.data)
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
  gateway?: AdoGateway,
): Promise<ShipPrResult> => {
  try {
    const branch = `feature/${id}`
    if (!(await branchExists($, directory, branch))) return NOT_ATTEMPTED
    if (!(await pushBranch($, directory, branch))) {
      await log("warn", `ship: git push failed for ${branch}`)
      return { attempted: true, created: false, reason: "git push failed" }
    }
    const platform = platformFor(config, kind)
    return platform === "ado" ? await shipAdo($, log, directory, gateway, config, branch, title) : await shipGithub($, log, directory, branch, title)
  } catch (err) {
    return { attempted: true, created: false, reason: (err as Error).message }
  }
}
