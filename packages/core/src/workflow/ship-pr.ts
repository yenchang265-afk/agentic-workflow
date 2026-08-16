import { z } from "zod"
import type { Log, Shell } from "../host.js"
import { platformFor, shipPublishFor, taskBranchFor } from "../config.js"
import { adoList } from "../source/ado-shared.js"
import type { AdoGateway } from "../source/ado-gateway.js"
import type { Config, ShipPublish } from "./state.js"
import { branchExists, currentBranch, pushBranch, remoteBranchExists } from "./git.js"

/**
 * Publish a ship-gated task's branch, as far as the effective `shipPublish`
 * mode asks for: push it and open (or reuse) a draft PR (`pr`, the default),
 * push it and stop (`push`), or do nothing at all (`local`). The PR platform is
 * GitHub or Azure DevOps, chosen by `platformFor(config, kind)`.
 *
 * Called only from the ship gate, after the task has already been moved to
 * `completed/`: this never throws, and a failure here must never fail the ship
 * — publishing is not a requirement of shipping. It must not be SILENT either:
 * the ship gate renders `reason` onto its `GateResult` as a warning (message +
 * `pr.opened`), not only into the audit note, which is invisible under the
 * default `ignoreBacklog: true` that never commits it.
 */

export interface ShipPrResult {
  /** False when there's no branch to ship (e.g. a manually authored task) — a silent no-op. */
  readonly attempted: boolean
  /**
   * The mode this call was asked for. The caller cannot re-derive it from
   * config: an explicit per-ship override wins over the config key, and it is
   * `shipPublishFor` here that resolves the two.
   */
  readonly mode: ShipPublish
  /**
   * Whether the branch actually reached `origin`.
   *
   * Load-bearing, not decoration: without it `attempted` conflates "push failed,
   * so nothing is on the remote" with "push succeeded, only the PR call failed",
   * and the ship gate's message had to stay vague about which happened. It is
   * also what tells `local` (deliberately unpushed) apart from a failed push.
   */
  readonly pushed: boolean
  /** True only when a new PR was opened this call; a reused existing PR still carries `url` with `created: false`. */
  readonly created: boolean
  readonly url?: string
  readonly reason?: string
  /** The branch acted on, so the gate's message and audit note can name it. */
  readonly branch?: string
  /**
   * The ref a PR was actually opened ONTO. Set only when a create call ran, so a
   * reused existing PR leaves it absent rather than asserting a target this call
   * never chose.
   */
  readonly base?: string
}

const notAttempted = (mode: ShipPublish): ShipPrResult => ({ attempted: false, mode, pushed: false, created: false })

/**
 * What a PR arm reports back. Only the `pr` mode reaches one, and only after a
 * successful push, so `attempted`/`mode`/`pushed`/`branch` are already decided
 * by `shipPr` — the arms would have to repeat the same three constants at every
 * one of their nine returns to say nothing new.
 */
type PrAttempt = Pick<ShipPrResult, "created" | "url" | "reason" | "base">

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

const shipGithub = async ($: Shell, log: Log, directory: string, branch: string, title: string, wanted?: string): Promise<PrAttempt> => {
  const existing = await ghExistingPrUrl($, directory, branch)
  if (existing) return { created: false, url: existing }
  // An explicit base skips the network lookup entirely — it is already the
  // answer, and asking anyway only adds a way to fail.
  //
  // The `currentBranch` fallback must never equal the head: in current-branch
  // mode (`taskBranch: false`) teardown leaves the tree ON the shipped branch,
  // so the old chain asked for a PR from a branch onto itself and `gh` refused.
  const cur = wanted ? null : await currentBranch($, directory)
  const base = wanted ?? (await ghDefaultBranch($, directory)) ?? (cur && cur !== branch ? cur : null) ?? "main"
  // No `--json`/`-q` here: those are `gh pr view`/`gh pr list` flags. `gh pr create`
  // rejects them ("unknown flag: --json") and prints the new PR's URL on stdout.
  const out = await $`gh pr create --draft --head ${branch} --base ${base} --title ${title} --body ${""}`
    .cwd(directory)
    .quiet()
    .nothrow()
  const url = out.stdout.toString().trim()
  if (out.exitCode === 0 && url) return { created: true, url, base }
  const reason = out.stderr.toString().trim() || "gh pr create failed"
  await log("warn", `ship: gh pr create failed for ${branch} — ${reason}`)
  return { created: false, reason }
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
  wanted?: string,
): Promise<PrAttempt> => {
  const ado = config.ado
  if (!ado) return { created: false, reason: "ado config missing" }
  if (!ado.repository) return { created: false, reason: "ado.repository not configured (required to open a PR)" }
  if (!gateway) return { created: false, reason: "no Azure DevOps MCP gateway configured" }

  const org = ado.organization.replace(/\/+$/, "")
  const project = ado.project
  const repository = ado.repository
  const prUrl = (id: number): string => `${org}/${project}/_git/${repository}/pullrequest/${id}`

  const existingId = await adoExistingPrId(gateway, project, repository, branch)
  if (existingId) return { created: false, url: prUrl(existingId) }

  // Same explicit-base short-circuit and head-is-not-base rule as the GitHub arm above.
  const cur = wanted ? null : await currentBranch($, directory)
  const base = wanted ?? (await adoDefaultBranch(gateway, project, repository)) ?? (cur && cur !== branch ? cur : null) ?? "main"
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
    return { created: false, reason }
  }
  try {
    const data = AdoPrRefSchema.parse(createOut.data)
    if (!data.pullRequestId) return { created: false, reason: "ADO PR create: no pullRequestId in response" }
    return { created: true, url: prUrl(data.pullRequestId), base }
  } catch (err) {
    return { created: false, reason: `ADO PR create: could not parse response — ${(err as Error).message}` }
  }
}

/**
 * Publish a task's branch to the extent the effective mode asks for. `kind`
 * resolves the platform via `platformFor` — the `<tasksDir>` file backlog is
 * always the `"engineering"` kind. Never throws.
 *
 * `publish` is the human's per-ship override; absent, the repo's `shipPublish`
 * decides, and absent that, `pr` — see `shipPublishFor`.
 *
 * `options.branch` is the branch the run ACTUALLY built on, read off the task
 * file by `extractRunBranch`. It is the authority when present, because the two
 * fallbacks are both guesses: the configured prefix is wrong if `taskBranch`
 * changed since the run, and in current-branch mode (`taskBranch: false`) no
 * id→branch function exists at all — there the tree's own branch is the last
 * resort, correct only because teardown deliberately leaves the tree on it.
 *
 * `options.base` is the already-resolved PR target (`shipBaseFor`), or absent to
 * let the platform name its own default branch.
 */
export interface ShipPrOptions {
  /** The branch the run built on — `extractRunBranch`'s answer. */
  readonly branch?: string
  /** The human's per-ship publish override. */
  readonly publish?: ShipPublish
  /** The PR's target ref, already resolved by `shipBaseFor`. Absent ⇒ ask the platform. */
  readonly base?: string
  /**
   * Whether `base` is the human's own `--base=<branch>` for THIS ship, as
   * opposed to a value resolved for them (the base the run recorded, or
   * `prBase`). Only the explicit one is refused when it is missing from origin —
   * see the probe below for why the two must part company there.
   */
  readonly baseExplicit?: boolean
}

export const shipPr = async (
  $: Shell,
  log: Log,
  directory: string,
  config: Config,
  kind: string,
  id: string,
  title: string,
  gateway?: AdoGateway,
  options: ShipPrOptions = {},
): Promise<ShipPrResult> => {
  // An options bag rather than two more positionals: `branch` and `base` are
  // adjacent same-typed branch names, and transposing them opens the PR backwards
  // (head `release/2.4` onto base `feature/t-42`) — a mistake types cannot catch
  // and one the remote will happily ACCEPT.
  const { branch, publish } = options
  const mode = shipPublishFor(config, publish)
  // Normalize once, here, so config values, `--base=` and the recorded run base
  // all reach the arms bare and neither can double-prefix `refs/heads/`.
  const wanted = options.base?.replace(/^refs\/heads\//, "") || undefined
  try {
    // Branch resolution runs FIRST for every mode, `local` included. "There is
    // no branch here" (a hand-authored task) is a different fact from "you asked
    // for nothing to be published", and only this order can report both: a
    // `local` short-circuit above it would claim a branch was deliberately kept
    // back when none ever existed.
    const head = branch ?? taskBranchFor(config, kind, id) ?? (await currentBranch($, directory))
    if (!head || !(await branchExists($, directory, head))) return notAttempted(mode)
    const common = { attempted: true, mode, branch: head } as const
    if (mode === "local") return { ...common, pushed: false, created: false }
    if (!(await pushBranch($, directory, head))) {
      await log("warn", `ship: git push failed for ${head}`)
      return { ...common, pushed: false, created: false, reason: "git push failed" }
    }
    if (mode === "push") return { ...common, pushed: true, created: false }
    // Checked AFTER the push (the work is safely on origin either way) and once
    // for both platforms. A platform-derived default is never probed: it came
    // from the platform itself, so re-asking buys nothing.
    //
    // What a miss does depends on WHO chose the base, and the two answers are
    // opposite on purpose:
    //
    //  - The human typed `--base=<branch>` and it is not on origin: REFUSE.
    //    Falling back would quietly open the PR onto the default branch —
    //    precisely the wrong-target failure this path exists to prevent — and
    //    recovery is cheap, because `publishNote` renders "PR not opened",
    //    which `prAlreadyRecorded` does not match, so
    //    `approve <id> --base=<correct>` re-enters the idempotent retry arm.
    //  - Nobody typed it — it is the base the run recorded, or `prBase`: fall
    //    through to the next rung instead. A run that took an isolation degrade
    //    path records whatever the tree was parked on, which is routinely a
    //    local-only branch, and refusing there means a task that reached the
    //    ship gate cleanly opens NO pull request and says only that a branch
    //    the human never chose is missing from origin. Warn and let the
    //    platform name its target, which is exactly what this ship did before
    //    the base was recorded at all.
    let target = wanted
    if (target && (await remoteBranchExists($, directory, target)) === "absent") {
      const reason = `base branch "${target}" is not on origin`
      if (options.baseExplicit) {
        await log("warn", `ship: ${reason} — PR not opened for ${head}`)
        return { ...common, pushed: true, created: false, reason }
      }
      await log("warn", `ship: ${reason} — it was not asked for on this ship, so the PR targets the platform's default instead; pass --base=<branch> to choose one`)
      target = undefined
    }
    const platform = platformFor(config, kind)
    const attempt =
      platform === "ado" ? await shipAdo($, log, directory, gateway, config, head, title, target) : await shipGithub($, log, directory, head, title, target)
    return { ...common, pushed: true, ...attempt }
  } catch (err) {
    // `pushed: false` is the honest answer for a throw: the only awaits that can
    // reach here either precede the push or ARE it, and `pushBranch` swallows a
    // failing git rather than throwing, so nothing that threw got past it.
    return { attempted: true, mode, pushed: false, created: false, reason: (err as Error).message, ...(branch ? { branch } : {}) }
  }
}
