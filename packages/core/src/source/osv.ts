import { z } from "zod"
import { severityRank, type Severity, type SemverImpact, type UpgradeCandidate } from "./dependency-scan.js"

/**
 * The pure OSV-Scanner report normalizer for the dependency-scan work
 * source's JVM ecosystems (maven/gradle): parses `osv-scanner --format json`
 * output and reduces each vulnerable package to the same `UpgradeCandidate`
 * shape the npm path produces, so one policy (severity floor, autoFix
 * classes, majors-never-claimed) governs every ecosystem.
 *
 * OSV facts the shapes below encode:
 * - `severity[].score` on a vulnerability is a CVSS *vector string*, not a
 *   number — the numeric signal is the report's own `groups[].max_severity`
 *   (a string like "8.1" osv-scanner computes from the vectors).
 * - The authoritative fixed version lives in
 *   `affected[].ranges[].events[].fixed`; a vulnerability may affect several
 *   packages, so events are read only from `affected` entries matching the
 *   package under judgement.
 */

const OsvEventSchema = z.object({
  introduced: z.string().optional(),
  fixed: z.string().optional(),
})

const OsvAffectedSchema = z.object({
  package: z.object({ name: z.string().default(""), ecosystem: z.string().default("") }).nullish(),
  ranges: z
    .array(z.object({ type: z.string().default(""), events: z.array(OsvEventSchema).default([]) }))
    .default([]),
})

const OsvVulnSchema = z.object({
  id: z.string().default(""),
  /** GHSA-style label (LOW/MODERATE/MEDIUM/HIGH/CRITICAL) when the record carries one. */
  database_specific: z.object({ severity: z.string().default("") }).nullish(),
  affected: z.array(OsvAffectedSchema).default([]),
})

const OsvGroupSchema = z.object({
  ids: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  /** Numeric string ("8.1") osv-scanner computes from the group's CVSS vectors. */
  max_severity: z.string().default(""),
})

const OsvPackageSchema = z.object({
  package: z.object({ name: z.string().default(""), version: z.string().default(""), ecosystem: z.string().default("") }),
  vulnerabilities: z.array(OsvVulnSchema).default([]),
  groups: z.array(OsvGroupSchema).default([]),
})

export const OsvReportSchema = z.object({
  results: z.array(z.object({ packages: z.array(OsvPackageSchema).default([]) })).default([]),
})
export type OsvReport = z.infer<typeof OsvReportSchema>

/**
 * Loose version compare for JVM-style versions (`2.9.10.8`, `5.3.39`,
 * `1.2.3.RELEASE`, `2.0.0-M1`): split on `.`/`-`; numeric segments compare
 * numerically; a numeric segment outranks a qualifier; a missing segment ties
 * with a trailing `0` and loses to any other numeric, but beats a qualifier
 * (`2.0.0` > `2.0.0-M1`). Not a full semver/Maven comparator — deliberately
 * simple, and the callers treat unparsable weirdness conservatively. Pure.
 */
export const compareLooseVersions = (a: string, b: string): number => {
  const split = (v: string) => v.trim().replace(/^v/, "").split(/[.-]/).filter(Boolean)
  const as = split(a)
  const bs = split(b)
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const x = as[i]
    const y = bs[i]
    if (x === y) continue
    const xNum = x !== undefined && /^\d+$/.test(x)
    const yNum = y !== undefined && /^\d+$/.test(y)
    if (x === undefined) {
      if (yNum && Number(y) === 0) continue
      return yNum ? -1 : 1
    }
    if (y === undefined) {
      if (xNum && Number(x) === 0) continue
      return xNum ? 1 : -1
    }
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (xNum !== yNum) return xNum ? 1 : -1
    const cmp = x.localeCompare(y)
    if (cmp !== 0) return cmp < 0 ? -1 : 1
  }
  return 0
}

/**
 * Semver-style impact of `current → target` for LOOSE (JVM) version strings, the
 * ordering-comparator's classifier sibling. The npm `semverImpact` demands three
 * numeric segments (`X.Y.Z`), so a two-segment Maven/Gradle version (`4.4 → 4.5`, a
 * minor bump) parses as unknown and is misclassified `major` — routed to
 * `skippedMajors` and never claimed even for a critical advisory (C3). This splits on
 * `.`/`-` like `compareLooseVersions`, compares the first three positions (missing ⇒ 0),
 * and stays conservative: an unreadable/qualifier-led major on either side ⇒ `major`.
 * Pure.
 */
export const looseImpact = (current: string, target: string): SemverImpact => {
  const split = (v: string) => v.trim().replace(/^v/, "").split(/[.-]/).filter(Boolean)
  const numAt = (arr: string[], i: number): number | null => {
    const s = arr[i]
    return s !== undefined && /^\d+$/.test(s) ? Number(s) : null
  }
  const c = split(current)
  const t = split(target)
  const cMaj = numAt(c, 0)
  const tMaj = numAt(t, 0)
  if (cMaj === null || tMaj === null) return "major" // can't read a numeric major ⇒ don't auto-fix
  if (cMaj !== tMaj) return "major"
  if ((numAt(c, 1) ?? 0) !== (numAt(t, 1) ?? 0)) return "minor"
  return "patch"
}

/** Band a numeric CVSS score string into the npm severity vocabulary; "" when unparsable. Pure. */
export const bandCvss = (score: string): Severity | "" => {
  const n = Number.parseFloat(score)
  if (Number.isNaN(n)) return ""
  if (n < 4) return "low"
  if (n < 7) return "moderate"
  if (n < 9) return "high"
  return "critical"
}

/** GHSA/OSV label → npm severity vocabulary ("MEDIUM"/"MODERATE" → moderate); "" when unrecognized. Pure. */
const normalizeLabel = (raw: string): Severity | "" => {
  const s = raw.toLowerCase()
  const mapped = s === "medium" ? "moderate" : s
  return severityRank(mapped) >= 0 ? (mapped as Severity) : ""
}

export interface OsvJudgement {
  readonly claimable: UpgradeCandidate[]
  readonly skippedMajors: UpgradeCandidate[]
  /** Vulnerable but not declared in the repo's build files — fixing a JVM transitive is dependencyManagement surgery, a human call. */
  readonly skippedTransitives: UpgradeCandidate[]
  /** At least one vulnerability has no fixed version above the current — nothing to upgrade to. */
  readonly unfixable: UpgradeCandidate[]
}

/**
 * Reduce an osv-scanner report to upgrade candidates under the shared policy.
 * Per package: each vulnerability's fix is the MINIMAL `fixed` event above
 * the current version (across the affected entries naming this package); the
 * package's target is the MAX of those per-vuln minimal fixes, so one bump
 * clears everything. Severity resolves per vulnerability —
 * `database_specific.severity` label first, else the covering group's
 * `max_severity` banded — and the package takes the worst. Packages below the
 * severity floor are dropped silently (npm-path parity); undeclared packages
 * land in `skippedTransitives`; majors/out-of-policy in `skippedMajors`. Pure.
 */
export const osvCandidates = (
  report: OsvReport,
  policy: { severityFloor: string; autoFix: readonly string[] },
  declared: (pkg: string) => boolean,
  ecosystem: "maven" | "gradle",
): OsvJudgement => {
  const out: OsvJudgement = { claimable: [], skippedMajors: [], skippedTransitives: [], unfixable: [] }
  const floor = severityRank(policy.severityFloor)
  for (const result of report.results) {
    for (const p of result.packages) {
      const pkg = p.package.name
      const current = p.package.version
      if (!pkg || p.vulnerabilities.length === 0) continue

      let severity: Severity | "" = ""
      let target = ""
      let fixable = true
      for (const vuln of p.vulnerabilities) {
        // Severity: label → covering group's banded max_severity.
        let vulnSev = normalizeLabel(vuln.database_specific?.severity ?? "")
        if (!vulnSev) {
          const group = p.groups.find((g) => g.ids.includes(vuln.id) || g.aliases.includes(vuln.id))
          vulnSev = group ? bandCvss(group.max_severity) : ""
        }
        if (severityRank(vulnSev) > severityRank(severity)) severity = vulnSev

        // Fix: minimal fixed event above current, from affected entries naming this package.
        const fixes = vuln.affected
          .filter((a) => !a.package?.name || a.package.name === pkg)
          .flatMap((a) => a.ranges)
          .flatMap((r) => r.events)
          .map((e) => e.fixed ?? "")
          .filter((f) => f && compareLooseVersions(f, current) > 0)
        if (fixes.length === 0) {
          fixable = false
          continue
        }
        const minimal = fixes.reduce((lo, f) => (compareLooseVersions(f, lo) < 0 ? f : lo))
        if (!target || compareLooseVersions(minimal, target) > 0) target = minimal
      }

      const impact = looseImpact(current, target)
      const candidate: UpgradeCandidate = { pkg, current, target, impact, severity, ecosystem }
      if (!fixable || !target) {
        out.unfixable.push({ ...candidate, target: "" })
        continue
      }
      // Below the floor (or severity unresolvable) — dropped silently, npm-path parity.
      if (severityRank(severity) < floor) continue
      if (!declared(pkg)) {
        out.skippedTransitives.push(candidate)
        continue
      }
      if (impact === "major" || !policy.autoFix.includes(impact)) {
        out.skippedMajors.push(candidate)
        continue
      }
      out.claimable.push(candidate)
    }
  }
  const bySeverityThenName = (a: UpgradeCandidate, b: UpgradeCandidate) =>
    severityRank(b.severity) - severityRank(a.severity) || a.pkg.localeCompare(b.pkg)
  out.claimable.sort(bySeverityThenName)
  return out
}
