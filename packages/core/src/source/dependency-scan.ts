import path from "node:path"
import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { LoopState } from "../loop/state.js"
import { slugify } from "../task/schema.js"
import type { ClaimSkipReason, TerminalOutcome, WorkItem, WorkSource } from "./types.js"

/**
 * The dependency-scan work source (dep-sitter): claimable units of work are
 * direct dependencies with a fixable advisory (`npm audit --json`) at or above
 * the manifest's severity floor — optionally plus plainly outdated direct
 * dependencies (`npm outdated --json`). One item per dependency, deduped by a
 * per-dependency ledger under `<tasksDir>/runs/<kind>/dep-<pkg>.json` so a
 * published or failed upgrade is never re-claimed until its target version
 * moves.
 *
 * Policy lives in the manifest (config `loops.<kind>` may override it): only
 * upgrades whose semver impact is within `autoFix` are claimed; a major bump
 * is never auto-fixed — it is logged and left for a human, keeping "majors
 * stay a human call" a structural guarantee rather than prompt guidance.
 *
 * The item enters the loop with no preset `git`: `ensureIsolation` cuts the
 * standard `feature/<slug>` branch from the human's current branch, and the
 * publish stage pushes that branch and opens a draft PR. GitHub-only in v1 —
 * the wiring skips this source when the kind's platform resolves to `ado`.
 */

const AuditFixSchema = z.union([
  z.boolean(),
  z.object({
    name: z.string().default(""),
    version: z.string().default(""),
    isSemVerMajor: z.boolean().default(false),
  }),
])

const AuditSchema = z.object({
  vulnerabilities: z
    .record(
      z.string(),
      z.object({
        name: z.string().default(""),
        severity: z.string().default(""),
        isDirect: z.boolean().default(false),
        fixAvailable: AuditFixSchema.default(false),
      }),
    )
    .default({}),
})

const LsSchema = z.object({
  dependencies: z.record(z.string(), z.object({ version: z.string().default("") })).default({}),
})

const OutdatedSchema = z.record(
  z.string(),
  z.object({ current: z.string().default(""), wanted: z.string().default("") }),
)

const DepLedgerSchema = z.object({
  pkg: z.string(),
  /** Target version a published upgrade PR already covers. */
  versionHandled: z.string().optional(),
  /** Capped/stopped attempts — the dependency parks until its target version moves. */
  failedAttempts: z.array(z.object({ target: z.string(), at: z.string() })).default([]),
  updatedAt: z.string(),
})
export type DepLedger = z.infer<typeof DepLedgerSchema>

export const SEVERITIES = ["low", "moderate", "high", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]
const severityRank = (s: string): number => SEVERITIES.indexOf(s as Severity)

export type SemverImpact = "patch" | "minor" | "major"

/** Classify `current → target`. Unparsable versions read as major — never auto-fixed. Pure. */
export const semverImpact = (current: string, target: string): SemverImpact => {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(current)
  const b = parse(target)
  if (!a || !b) return "major"
  if (a[0] !== b[0]) return "major"
  if (a[1] !== b[1]) return "minor"
  return "patch"
}

/** One claimable upgrade, normalized from the npm reports. */
export interface UpgradeCandidate {
  readonly pkg: string
  readonly current: string
  readonly target: string
  readonly impact: SemverImpact
  /** Advisory severity; "" for a plain outdated (non-vulnerable) dependency. */
  readonly severity: string
}

/**
 * The claimable upgrades, in claim-priority order (severity first, then name).
 * Majors are returned under `skippedMajors` — surfaced in the log, never
 * claimed. Pure over the parsed npm reports.
 */
export const upgradeCandidates = (
  audit: z.infer<typeof AuditSchema>,
  installed: Readonly<Record<string, string>>,
  outdated: z.infer<typeof OutdatedSchema>,
  policy: { severityFloor: string; autoFix: readonly string[]; includeOutdated: boolean },
): { claimable: UpgradeCandidate[]; skippedMajors: UpgradeCandidate[] } => {
  const floor = severityRank(policy.severityFloor)
  const byPkg = new Map<string, UpgradeCandidate>()
  const majors: UpgradeCandidate[] = []
  for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
    if (!v.isDirect || severityRank(v.severity) < floor) continue
    if (typeof v.fixAvailable === "boolean" || v.fixAvailable.name !== pkg || !v.fixAvailable.version) continue
    const current = installed[pkg] ?? ""
    const target = v.fixAvailable.version
    const impact = v.fixAvailable.isSemVerMajor ? "major" : semverImpact(current || target, target)
    const candidate: UpgradeCandidate = { pkg, current, target, impact, severity: v.severity }
    if (impact === "major" || !policy.autoFix.includes(impact)) majors.push(candidate)
    else byPkg.set(pkg, candidate)
  }
  if (policy.includeOutdated) {
    for (const [pkg, o] of Object.entries(outdated)) {
      if (byPkg.has(pkg) || !o.current || !o.wanted || o.current === o.wanted) continue
      const impact = semverImpact(o.current, o.wanted)
      if (impact === "major" || !policy.autoFix.includes(impact)) continue
      byPkg.set(pkg, { pkg, current: o.current, target: o.wanted, impact, severity: "" })
    }
  }
  const claimable = [...byPkg.values()].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.pkg.localeCompare(b.pkg),
  )
  return { claimable, skippedMajors: majors }
}

const ledgerRel = (tasksDir: string, kind: string, pkg: string): string =>
  `${tasksDir}/runs/${kind}/dep-${slugify(pkg)}.json`

interface DependencyScanDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Config overrides of the manifest policy (`loops.<kind>.severityFloor` …). */
  readonly severityFloor?: string
  readonly includeOutdated?: boolean
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeDependencyScanSource = (deps: DependencyScanDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "dependency-scan") {
    throw new Error(`loop kind "${loaded.manifest.kind}" does not use a dependency-scan work source`)
  }
  const kind = loaded.manifest.kind
  const policy = {
    severityFloor: deps.severityFloor && SEVERITIES.includes(deps.severityFloor as Severity)
      ? deps.severityFloor
      : binding.severityFloor,
    autoFix: binding.autoFix,
    includeOutdated: deps.includeOutdated ?? binding.includeOutdated,
  }
  const now = deps.now ?? (() => new Date().toISOString())
  const claimsDir = `${directory}/${tasksDir}/runs/${kind}/.claims`

  const loadDepLedger = async (pkg: string): Promise<DepLedger> => {
    const read = await client.file.read({ query: { path: ledgerRel(tasksDir, kind, pkg), directory } }).catch(() => null)
    const empty: DepLedger = { pkg, failedAttempts: [], updatedAt: now() }
    const content = read?.data?.content
    if (!content) return empty
    try {
      const parsed = DepLedgerSchema.safeParse(JSON.parse(content))
      return parsed.success ? parsed.data : empty
    } catch {
      return empty
    }
  }

  const saveDepLedger = async (ledger: DepLedger): Promise<void> => {
    const dir = path.join(directory, tasksDir, "runs", kind)
    await $`mkdir -p ${dir}`.quiet().nothrow()
    const file = path.join(dir, `dep-${slugify(ledger.pkg)}.json`)
    await $`printf '%s' ${JSON.stringify(ledger, null, 2)} > ${file}`.quiet().nothrow()
  }

  const workItem = (c: UpgradeCandidate): WorkItem => {
    const advisory = c.severity ? `${c.severity}-severity advisory` : "outdated dependency"
    // The first line seeds `loopId` → the loop's feature/<slug> branch name.
    const goal =
      `Upgrade ${c.pkg} to ${c.target}\n\n` +
      `${c.current ? `Currently on ${c.current} — a` : "A"} ${c.impact} bump closing a ${advisory}. ` +
      `Apply the upgrade (lockfile included), fix any fallout, verify the suite is green, then push the branch ` +
      `and open a DRAFT pull request. Never merge it, and never touch versions this work order doesn't name.`
    const state: LoopState = {
      kind,
      goal,
      stage: loaded.manifest.stages[0]?.name ?? "scan",
      iteration: 0,
      artifacts: {},
      platform: "github",
    }
    return {
      id: `dep-${slugify(c.pkg)}`,
      loopKind: kind,
      title: `Upgrade ${c.pkg} ${c.current || "?"} → ${c.target}`,
      entryStage: state.stage,
      state,
      claimMessage: `Watch: claimed dependency upgrade ${c.pkg} → ${c.target} (${c.severity || "outdated"})`,
      ref: { candidate: c },
    }
  }

  return {
    loopKind: kind,

    async claimNext() {
      // npm audit exits non-zero when vulnerabilities exist — the report is on
      // stdout either way, so only an unparsable/empty report is an error.
      const auditOut = await $`npm audit --json`.cwd(directory).quiet().nothrow()
      let audit: z.infer<typeof AuditSchema>
      try {
        audit = AuditSchema.parse(JSON.parse(auditOut.stdout.toString() || "{}"))
      } catch (err) {
        return {
          item: null,
          skip: {
            message: `${kind}: could not parse npm audit output — ${(err as Error).message}`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      const lsOut = await $`npm ls --json --depth=0`.cwd(directory).quiet().nothrow()
      let installed: Record<string, string> = {}
      try {
        const ls = LsSchema.parse(JSON.parse(lsOut.stdout.toString() || "{}"))
        installed = Object.fromEntries(Object.entries(ls.dependencies).map(([k, v]) => [k, v.version]))
      } catch {
        /* versions stay unknown — impact falls back to the audit's isSemVerMajor */
      }
      let outdated: z.infer<typeof OutdatedSchema> = {}
      if (policy.includeOutdated) {
        // npm outdated exits 1 whenever anything is outdated; the JSON is still complete.
        const out = await $`npm outdated --json`.cwd(directory).quiet().nothrow()
        try {
          outdated = OutdatedSchema.parse(JSON.parse(out.stdout.toString() || "{}"))
        } catch {
          /* ignore — audit-driven candidates still stand */
        }
      }
      const { claimable, skippedMajors } = upgradeCandidates(audit, installed, outdated, policy)
      for (const major of skippedMajors) {
        await log(
          "info",
          `${kind}: ${major.pkg} needs a ${major.impact} bump to ${major.target} (${major.severity || "outdated"}) — skipped, majors stay a human call`,
        )
      }
      const heldIds: string[] = []
      for (const candidate of claimable) {
        const ledger = await loadDepLedger(candidate.pkg)
        if (ledger.versionHandled === candidate.target) continue
        if (ledger.failedAttempts.some((f) => f.target === candidate.target)) continue
        await $`mkdir -p ${claimsDir}`.quiet().nothrow()
        const marker = await $`mkdir ${`${claimsDir}/dep-${slugify(candidate.pkg)}`}`.quiet().nothrow()
        if (marker.exitCode !== 0) {
          heldIds.push(`dep-${slugify(candidate.pkg)}`)
          continue
        }
        return { item: workItem(candidate), skip: null }
      }
      if (heldIds.length) {
        return {
          item: null,
          skip: { message: `${kind}: claim marker held for ${heldIds.join(", ")}`, actionable: true },
        }
      }
      return {
        item: null,
        skip: {
          message: `${kind}: no auto-fixable upgrades (${claimable.length} candidates, ${skippedMajors.length} major/out-of-policy)`,
          actionable: false,
        },
      }
    },

    async release(work) {
      const { candidate } = work.ref as { candidate: UpgradeCandidate }
      await $`rmdir ${`${claimsDir}/dep-${slugify(candidate.pkg)}`}`.quiet().nothrow()
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { candidate } = work.ref as { candidate: UpgradeCandidate }
      const ledger = await loadDepLedger(candidate.pkg)
      const updated: DepLedger =
        outcome.kind === "done"
          ? { ...ledger, versionHandled: candidate.target, updatedAt: now() }
          : {
              ...ledger,
              failedAttempts: [...ledger.failedAttempts, { target: candidate.target, at: now() }],
              updatedAt: now(),
            }
      await saveDepLedger(updated)
      await $`rmdir ${`${claimsDir}/dep-${slugify(candidate.pkg)}`}`.quiet().nothrow()
    },
  }
}
