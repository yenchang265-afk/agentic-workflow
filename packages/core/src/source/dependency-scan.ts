import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { acquireMarker, markerOlderThan, releaseMarker, STALE_CLAIM_MINUTES } from "../claim-marker.js"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { CodePlatform, WorkflowState } from "../workflow/state.js"
import { writeFileAtomic } from "../fsatomic.js"
import { osvCandidates } from "./osv.js"
import { parseOsvPayload } from "./osv-payload.js"
import { slugify } from "../task/schema.js"
import type { ClaimSkipReason, TerminalOutcome, WorkItem, WorkSource } from "./types.js"

/**
 * The dependency-scan work source (dep-sitter): claimable units of work are
 * direct dependencies with a fixable advisory at or above the manifest's
 * severity floor. Three ecosystems, one policy:
 *
 * - **npm** — the native reports (`npm audit --json`, `npm ls`, optionally
 *   `npm outdated`), the richest path (registry-pinned `fixAvailable`
 *   targets, `isSemVerMajor`).
 * - **maven / gradle** — OSV-Scanner (`osv-scanner --format json -L <file>`
 *   over `pom.xml` / the Gradle lockfile), normalized by `osv.ts` into the
 *   same candidate shape. Gradle needs dependency locking (`gradle.lockfile`
 *   or `gradle/verification-metadata.xml`) — osv-scanner cannot parse
 *   `build.gradle` itself; a repo without one gets an actionable skip.
 *   Vulnerable packages NOT declared in the build files (transitives) are
 *   logged, never claimed — pinning a JVM transitive is dependencyManagement
 *   surgery, a human call, mirroring npm's `isDirect`.
 *
 * The manifest's `ecosystem` binding (default `auto`) picks the adapters:
 * `auto` detects every ecosystem the repo declares and merges their
 * candidates (severity-first across ecosystems — monorepos work). One item
 * per dependency, deduped by a per-dependency ledger under
 * `<tasksDir>/runs/<kind>/dep-<pkg>.json` so a published or failed upgrade
 * is never re-claimed until its target version moves.
 *
 * Policy lives in the manifest (config `workflows.<kind>` may override it): only
 * upgrades whose semver impact is within `autoFix` are claimed; a major bump
 * is never auto-fixed — it is logged and left for a human, keeping "majors
 * stay a human call" a structural guarantee rather than prompt guidance.
 * `includeOutdated` is npm-only (JVM staleness would need build-plugin setup
 * the sitter must not perform).
 *
 * The item enters the loop with no preset `git`: `ensureIsolation` cuts the
 * standard `feature/<slug>` branch from the human's current branch, and the
 * publish stage pushes that branch and opens a draft PR. The source itself is
 * platform-agnostic (dependency reports don't care which forge the repo lives
 * on) — only the publish stage's PR-creation call differs, so the entry state
 * is stamped with whichever platform the kind resolves to (`deps.platform`).
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
/** Rank within SEVERITIES; -1 for unknown/"" (below every floor). Shared with the OSV normalizer. */
export const severityRank = (s: string): number => SEVERITIES.indexOf(s as Severity)

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

/** One claimable upgrade, normalized from an ecosystem's reports. */
export interface UpgradeCandidate {
  readonly pkg: string
  readonly current: string
  readonly target: string
  readonly impact: SemverImpact
  /** Advisory severity; "" for a plain outdated (non-vulnerable) dependency. */
  readonly severity: string
  /** The ecosystem the candidate came from; absent ⇒ npm (the original path). */
  readonly ecosystem?: "npm" | "maven" | "gradle"
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

export type DepEcosystem = "npm" | "maven" | "gradle"

/** The ecosystems a repo declares, probed via its manifest files. Exported for tests. Pure over `exists`. */
export const detectEcosystems = async (exists: (rel: string) => Promise<boolean>): Promise<DepEcosystem[]> => {
  const out: DepEcosystem[] = []
  if (await exists("package.json")) out.push("npm")
  if (await exists("pom.xml")) out.push("maven")
  if ((await exists("build.gradle")) || (await exists("build.gradle.kts"))) out.push("gradle")
  return out
}

/** Claim-priority order across merged ecosystems — the same severity-then-name order each adapter uses. */
const bySeverityThenName = (a: UpgradeCandidate, b: UpgradeCandidate): number =>
  severityRank(b.severity) - severityRank(a.severity) || a.pkg.localeCompare(b.pkg)

/**
 * Per-dependency artifact key (ledger file, claim marker, work-item id).
 * `slugify` alone collides across distinct packages — `@babel/core` and
 * `babel-core` both slug to `babel-core`; scoped vs unscoped and
 * `group:artifact` names likewise — and a collision lets one package's
 * ledger silently suppress ANOTHER package's security upgrade. A short
 * digest of the raw name disambiguates while keeping the slug readable.
 */
export const depKey = (pkg: string): string =>
  `dep-${slugify(pkg)}-${createHash("sha256").update(pkg).digest("hex").slice(0, 8)}`

const ledgerRel = (tasksDir: string, kind: string, pkg: string): string =>
  `${tasksDir}/runs/${kind}/${depKey(pkg)}.json`

/**
 * Substitute the work source's placeholders into a configured scanner command.
 * `{{target}}` is the lockfile path and `{{ecosystem}}` the ecosystem name —
 * both INTERNAL CONSTANTS (`pom.xml`, `gradle.lockfile`, `maven`), never remote
 * data — so the result is spliced raw, exactly the `worktreeSetup` contract
 * (isolate.ts). A command naming no `{{target}}` gets nothing appended: a
 * corporate scanner may legitimately scan the whole repo. Unrecognized
 * `{{name}}` placeholders survive verbatim and are RETURNED rather than
 * silently shipped to the shell — a typo'd `{{targt}}` must be visible. Pure.
 */
export const renderScannerCommand = (
  command: string,
  vars: { readonly target: string; readonly ecosystem: string },
): { readonly command: string; readonly unknown: string[] } => {
  const unknown: string[] = []
  const rendered = command.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (name === "target") return vars.target
    if (name === "ecosystem") return vars.ecosystem
    if (!unknown.includes(name)) unknown.push(name)
    return match
  })
  return { command: rendered, unknown }
}

interface DependencyScanDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Config overrides of the manifest policy (`workflows.<kind>.severityFloor` …). */
  readonly severityFloor?: string
  readonly includeOutdated?: boolean
  /** Config override of the manifest's ecosystem binding (`workflows.<kind>.ecosystem`). */
  readonly ecosystem?: string
  /**
   * Config override of the JVM scan command (`workflows.<kind>.scannerCommand`;
   * USER-scope only — see config.ts SHELL_BEARING_WORKFLOW_KEYS). Replaces the
   * bundled osv-scanner invocation for maven/gradle; npm is unaffected.
   */
  readonly scannerCommand?: string
  /** The resolved code platform (`platformFor(config, kind)`) stamped onto entry state; defaults to `github`. */
  readonly platform?: CodePlatform
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeDependencyScanSource = (deps: DependencyScanDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "dependency-scan") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a dependency-scan work source`)
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
  const platform: CodePlatform = deps.platform ?? "github"
  const requested: "auto" | DepEcosystem =
    deps.ecosystem === "npm" || deps.ecosystem === "maven" || deps.ecosystem === "gradle" || deps.ecosystem === "auto"
      ? deps.ecosystem
      : binding.ecosystem
  const claimsDir = `${directory}/${tasksDir}/runs/${kind}/.claims`
  const depMarker = (pkg: string): string => `${claimsDir}/${depKey(pkg)}`
  /** Win the dependency's marker, sweeping it first if a dead run left it behind. */
  const claimDep = async (pkg: string): Promise<boolean> => {
    if (await acquireMarker($, depMarker(pkg))) return true
    if (!(await markerOlderThan($, depMarker(pkg), STALE_CLAIM_MINUTES))) return false
    await releaseMarker($, depMarker(pkg))
    return acquireMarker($, depMarker(pkg))
  }

  const readText = async (rel: string): Promise<string> => {
    const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null)
    return read?.data?.content ?? ""
  }
  // Presence = the read succeeded, NOT non-empty content — an empty pom.xml /
  // package.json still declares its ecosystem.
  const exists = async (rel: string): Promise<boolean> => {
    const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null)
    return read?.data?.content != null
  }

  /** What one ecosystem's scan yielded — candidates to merge, or a reason it couldn't scan. */
  type Collected =
    | { readonly claimable: UpgradeCandidate[]; readonly skippedMajors: UpgradeCandidate[]; readonly notes: string[] }
    | { readonly skip: ClaimSkipReason }

  const collectNpm = async (): Promise<Collected> => {
    // npm audit exits non-zero when vulnerabilities exist — the report is on
    // stdout either way, so a non-zero exit is NOT itself an error. What is an
    // error is a report we cannot read: empty stdout, or a body with no
    // `vulnerabilities` key (npm writes `{"error":{...}}` for EUSAGE — no
    // lockfile, unreachable registry, npm missing). Both must surface as an
    // actionable skip, because `AuditSchema` defaults `vulnerabilities` to `{}`
    // and would otherwise turn a failed scan into a confident "0 candidates" —
    // a dep-sitter reporting healthy forever while never actually scanning.
    const auditOut = await $`npm audit --json`.cwd(directory).quiet().nothrow()
    const auditRaw = auditOut.stdout.toString().trim()
    const failedScan = (detail: string): Collected => ({
      skip: {
        message:
          `${kind}: npm audit did not produce a report (${detail}) — no vulnerabilities could be assessed. ` +
          `Check that this project has a lockfile and that npm can reach the registry.`,
        actionable: true,
      },
    })
    if (!auditRaw) return failedScan(auditOut.stderr.toString().trim() || `exit ${auditOut.exitCode}`)
    let audit: z.infer<typeof AuditSchema>
    try {
      const parsed: unknown = JSON.parse(auditRaw)
      if (typeof parsed !== "object" || parsed === null || !("vulnerabilities" in parsed)) {
        return failedScan(auditOut.stderr.toString().trim() || "no `vulnerabilities` in the report")
      }
      audit = AuditSchema.parse(parsed)
    } catch (err) {
      return { skip: { message: `${kind}: could not parse npm audit output — ${(err as Error).message}`, actionable: true } }
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
    return { claimable, skippedMajors, notes: [] }
  }

  /**
   * Shared OSV path for the JVM ecosystems: run a scanner, judge via osv.ts.
   *
   * Two branches, deliberately kept literally separate so the default
   * osv-scanner invocation stays byte-identical (a scripted-shell log test pins
   * it). `parseOsvPayload` serves BOTH, so an osv-scanner report and a
   * corporate CLI's raw OSV records need no `format` knob to tell apart.
   */
  const collectOsv = async (eco: "maven" | "gradle", target: string, declared: (pkg: string) => boolean): Promise<Collected> => {
    const custom = deps.scannerCommand?.trim()
    const notes: string[] = []
    let out: Awaited<ReturnType<Shell>>
    let shown: string
    if (custom) {
      // No `--version` probe: it exists only to emit the brew/go install hint,
      // which we have none of for a site's own binary. A missing command
      // surfaces below as empty stdout + its exit code, which says more.
      const rendered = renderScannerCommand(custom, { target, ecosystem: eco })
      shown = rendered.command
      for (const name of rendered.unknown) {
        notes.push(`${kind}: scannerCommand contains an unrecognized placeholder {{${name}}} — passed to the shell verbatim`)
      }
      out = await $`${{ raw: shown }}`.cwd(directory).quiet().nothrow()
    } else {
      const probe = await $`osv-scanner --version`.cwd(directory).quiet().nothrow()
      if (probe.exitCode !== 0) {
        return {
          skip: {
            message:
              `${kind}: osv-scanner not found — install it (e.g. \`brew install osv-scanner\`, or ` +
              `\`go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest\`) so the sitter can scan ${eco} dependencies.`,
            actionable: true,
          },
        }
      }
      shown = `osv-scanner --format json -L ${target}`
      // Exit 0 = clean, 1 = vulnerabilities found; the JSON report is on stdout either way.
      out = await $`osv-scanner --format json -L ${target}`.cwd(directory).quiet().nothrow()
    }

    // Empty stdout is a FAILED scan, not a clean one. Parsing `"" || "{}"` into
    // a zero-package report — as this path used to — turns a scanner that
    // silently died into a confident "no vulnerabilities", forever. Same rule
    // the npm path already enforces above.
    const stdout = out.stdout.toString().trim()
    if (!stdout) {
      return {
        skip: {
          message:
            `${kind}: \`${shown}\` produced no output (${out.stderr.toString().trim() || `exit ${out.exitCode}`}) — no ${eco} ` +
            `vulnerabilities could be assessed, which is NOT the same as none existing.` +
            (custom ? ` Check workflows.${kind}.scannerCommand in your user-scope config.` : ""),
          actionable: true,
        },
      }
    }
    // Both JVM ecosystems are "Maven" in OSV's ecosystem vocabulary (Gradle
    // resolves Maven coordinates), so one filter value serves both.
    const parsed = parseOsvPayload(stdout, { ecosystem: "Maven" })
    if ("error" in parsed) {
      return {
        skip: { message: `${kind}: could not read \`${shown}\` output for ${target} — ${parsed.error}`, actionable: true },
      }
    }
    notes.push(...parsed.notes.map((n) => `${kind}: ${n}`))
    const judged = osvCandidates(parsed.report, policy, declared, eco)
    notes.push(
      ...judged.unfixable.map(
        (c) => `${kind}: ${c.pkg} ${c.current} has advisories with no fixed version above it — nothing to upgrade to yet`,
      ),
      ...judged.skippedTransitives.map(
        (c) => `${kind}: ${c.pkg} is vulnerable but not declared in the build files (transitive) — pinning it stays a human call`,
      ),
    )
    if (policy.includeOutdated) notes.push(`${kind}: includeOutdated is npm-only for now — ignored for ${eco}`)
    return { claimable: judged.claimable, skippedMajors: judged.skippedMajors, notes }
  }

  const collectMaven = async (): Promise<Collected> => {
    const pom = await readText("pom.xml")
    if (!pom) {
      return { skip: { message: `${kind}: ecosystem "maven" is configured but no pom.xml was found`, actionable: true } }
    }
    // Declared = the artifactId appears in the pom — npm's isDirect, JVM-style.
    const declared = (pkg: string): boolean => {
      const artifact = pkg.split(":").pop() ?? pkg
      return pom.includes(`<artifactId>${artifact}</artifactId>`)
    }
    return collectOsv("maven", "pom.xml", declared)
  }

  const collectGradle = async (): Promise<Collected> => {
    const lockfile = (await exists("gradle.lockfile"))
      ? "gradle.lockfile"
      : (await exists("gradle/verification-metadata.xml"))
        ? "gradle/verification-metadata.xml"
        : null
    if (!lockfile) {
      return {
        skip: {
          message:
            `${kind}: gradle project without a lockfile — osv-scanner cannot parse build.gradle itself. Enable dependency ` +
            `locking (\`dependencyLocking { lockAllConfigurations() }\` + \`./gradlew dependencies --write-locks\`) and commit gradle.lockfile.`,
          actionable: true,
        },
      }
    }
    const declarationText = [
      await readText("build.gradle"),
      await readText("build.gradle.kts"),
      await readText("gradle/libs.versions.toml"),
    ].join("\n")
    // Declared = the full group:artifact appears in a build file or the version catalog.
    const declared = (pkg: string): boolean => declarationText.includes(pkg)
    return collectOsv("gradle", lockfile, declared)
  }

  const adapters: Record<DepEcosystem, () => Promise<Collected>> = {
    npm: collectNpm,
    maven: collectMaven,
    gradle: collectGradle,
  }

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
    const file = path.join(dir, `${depKey(ledger.pkg)}.json`)
    await writeFileAtomic($, file, JSON.stringify(ledger, null, 2))
  }

  const workItem = (c: UpgradeCandidate): WorkItem => {
    const advisory = c.severity ? `${c.severity}-severity advisory` : "outdated dependency"
    // Ecosystem-specific commands ride in the work order itself — the stage
    // prompts defer to it, so no template-context plumbing is needed. The npm
    // goal stays byte-identical to the original (regression pin).
    //
    // A site's own scanner is NOT on any stage's bash allowlist and cannot be
    // put there (OpenCode's permission map is static, generated at build time),
    // so when one is configured the confirm clause is replaced rather than
    // renamed: the work source already pinned the advisory and the target
    // before this item existed, leaving the stage the checks it CAN run.
    const confirm = (defaultCmd: string): string =>
      deps.scannerCommand?.trim()
        ? `The advisory and target were confirmed by the configured dependency scanner at claim time and are ` +
          `established fact — do NOT re-run a scanner (it is not on this stage's allowlist). Confirm instead that ` +
          `the build files still declare ${c.pkg} at ${c.current}, that ${c.target} exists, and that the bump stays ` +
          `within the stated impact.`
        : `confirm the advisory with \`${defaultCmd}\`.`
    const guidance =
      c.ecosystem === "maven"
        ? ` Ecosystem: Maven — ${confirm("osv-scanner --format json -L pom.xml")} If the version is ` +
          `managed by the Spring Boot BOM (or another imported BOM), override its version property or bump the parent ` +
          `rather than hardcoding a literal; otherwise ` +
          `\`mvn versions:use-dep-version -Dincludes=${c.pkg} -DdepVersion=${c.target} -DforceVersion=true\`. ` +
          `Verify with \`./mvnw verify\` (or \`mvn verify\`).`
        : c.ecosystem === "gradle"
          ? ` Ecosystem: Gradle — ${confirm("osv-scanner --format json -L gradle.lockfile")} Bump the ` +
            `version in \`gradle/libs.versions.toml\` (version catalog) or the dependency string in \`build.gradle(.kts)\`, ` +
            `refresh the lockfile with \`./gradlew dependencies --write-locks\`, and verify with \`./gradlew check\` (or \`build\`).`
          : ""
    // The first line seeds `workflowId` → the loop's feature/<slug> branch name.
    const goal =
      `Upgrade ${c.pkg} to ${c.target}\n\n` +
      `${c.current ? `Currently on ${c.current} — a` : "A"} ${c.impact} bump closing a ${advisory}. ` +
      `Apply the upgrade (lockfile included), fix any fallout, verify the suite is green, then push the branch ` +
      `and open a DRAFT pull request. Never merge it, and never touch versions this work order doesn't name.` +
      guidance
    const state: WorkflowState = {
      kind,
      goal,
      stage: loaded.manifest.stages[0]?.name ?? "scan",
      iteration: 0,
      artifacts: {},
      platform,
    }
    return {
      id: depKey(c.pkg),
      workflowKind: kind,
      title: `Upgrade ${c.pkg} ${c.current || "?"} → ${c.target}`,
      entryStage: state.stage,
      state,
      claimMessage: `Watch: claimed dependency upgrade ${c.pkg} → ${c.target} (${c.severity || "outdated"})`,
      ref: { candidate: c },
    }
  }

  return {
    workflowKind: kind,

    async claimNext() {
      // Resolve the active ecosystems: an explicit binding names one adapter;
      // auto detects everything the repo declares and merges the candidates.
      const active: DepEcosystem[] = requested === "auto" ? await detectEcosystems(exists) : [requested]
      if (active.length === 0) {
        return {
          item: null,
          skip: {
            message: `${kind}: no supported dependency manifests found (package.json / pom.xml / build.gradle)`,
            actionable: false,
          } satisfies ClaimSkipReason,
        }
      }
      const claimable: UpgradeCandidate[] = []
      const skippedMajors: UpgradeCandidate[] = []
      const adapterSkips: ClaimSkipReason[] = []
      for (const eco of active) {
        const collected = await adapters[eco]()
        if ("skip" in collected) {
          adapterSkips.push(collected.skip)
          continue
        }
        for (const note of collected.notes) await log("info", note)
        claimable.push(...collected.claimable)
        skippedMajors.push(...collected.skippedMajors)
      }
      claimable.sort(bySeverityThenName)
      for (const major of skippedMajors) {
        await log(
          "info",
          `${kind}: ${major.pkg} needs a ${major.impact} bump to ${major.target} (${major.severity || "outdated"}) — skipped, majors stay a human call`,
        )
      }
      // One broken adapter must not block the others: with candidates in hand,
      // its skip is logged and the claim proceeds (npm keeps working without
      // osv-scanner installed). With nothing to claim, surface the first
      // actionable skip so the human learns what to fix.
      if (claimable.length === 0) {
        const actionable = adapterSkips.find((s) => s.actionable)
        if (actionable) return { item: null, skip: actionable }
      } else {
        for (const s of adapterSkips) await log("warn", s.message)
      }
      const heldIds: string[] = []
      for (const candidate of claimable) {
        const ledger = await loadDepLedger(candidate.pkg)
        if (ledger.versionHandled === candidate.target) continue
        if (ledger.failedAttempts.some((f) => f.target === candidate.target)) continue
        // A stale marker is swept before we give up: without it a crashed run
        // wedged this dependency forever (see `claim-marker.ts`).
        if (!(await claimDep(candidate.pkg))) {
          heldIds.push(depKey(candidate.pkg))
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
      await releaseMarker($, depMarker(candidate.pkg))
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { candidate } = work.ref as { candidate: UpgradeCandidate }
      const ledger = await loadDepLedger(candidate.pkg)
      // A retryable stop (transient onError / interrupt) leaves the ledger untouched so
      // the next poll re-claims this target; only done and a genuine (cap) stop update it.
      const updated: DepLedger =
        outcome.kind === "done"
          ? { ...ledger, versionHandled: candidate.target, updatedAt: now() }
          : outcome.retryable
            ? ledger
            : {
                ...ledger,
                failedAttempts: [...ledger.failedAttempts, { target: candidate.target, at: now() }],
                updatedAt: now(),
              }
      if (updated !== ledger) await saveDepLedger(updated)
      await releaseMarker($, depMarker(candidate.pkg))
    },
  }
}
