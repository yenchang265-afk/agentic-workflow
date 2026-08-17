import { bandSeverityVectors, normalizeLabel, OsvReportSchema, type OsvReport } from "./osv.js"
import { severityRank, type Severity } from "./dependency-scan.js"

/**
 * Tolerant entry point for every OSV-shaped scanner payload the dep-sitter's
 * JVM path accepts, so one parser serves both the bundled osv-scanner and a
 * `workflows.<kind>.scannerCommand` corporate CLI without a `format` knob:
 *
 * - `{results:[{packages:[…]}]}` — an osv-scanner report; parsed as-is,
 *   byte-for-byte the pre-existing behavior.
 * - `{vulns|vulnerabilities|findings:[…]}` or a bare `[…]` — a list of raw OSV
 *   *vulnerability records*, grouped here into the internal report shape.
 *
 * Grouping is what lets `osvCandidates` stay untouched. It reads severity
 * label-first from a record's `database_specific.severity` (osv.ts:179) and
 * reads fixes through a per-package `affected` filter (osv.ts:187-188), so this
 * module writes the resolved rating into that one field and carries each
 * record's FULL `affected` array along rather than second-guessing the filter.
 *
 * Two facts a raw record is not REQUIRED to carry are probed rather than
 * assumed, and neither is ever dropped silently:
 *
 * - the **installed version** (standard OSV has no such field), and
 * - the **rating**, which a compliant record carries only as a CVSS vector in
 *   `severity[].score` (scored via osv.ts's `bandSeverityVectors`), while a
 *   site's own scanner may instead supply a label whose vocabulary is
 *   site-specific.
 *
 * A per-record failure is a note; a payload where EVERY record fails the same
 * way is an error. That asymmetry is the point: one malformed record must not
 * blind the scan to the rest, but a wholesale shape or vocabulary mismatch
 * would otherwise parse cleanly into a report whose every package sits below
 * the floor — a dep-sitter that scans successfully and claims nothing, forever.
 * Same failure class the npm path guards against at dependency-scan.ts:249-268.
 *
 * Pure — no shell, no fs, no clock.
 */

/**
 * Where an installed version may hide on an `affected` entry, most explicit
 * first. `versions[0]` is LAST and low-confidence on purpose: in standard OSV
 * `versions[]` enumerates every AFFECTED version, so its first element is the
 * oldest affected release, not what the repo has installed — and a wrong
 * `current` drives `looseImpact`, where too high lets a major bump read as
 * minor and get auto-claimed. Exported so a real payload pins the order.
 */
export const INSTALLED_VERSION_FIELDS = [
  "package.version",
  "database_specific.installed",
  "database_specific.installedVersion",
  "database_specific.current_version",
  "versions[0]",
] as const

/** Where the rating came from — carried into the notes so a misdiagnosed payload is visible in the log rather than inferred from a suspiciously empty claim list. */
export type SeveritySource = "severity" | "database_specific" | "severity-array" | "cvss-vector" | "none"

/**
 * The rating a record carries, and where it was found. `raw` is the string
 * VERBATIM as the scanner wrote it — deliberately un-normalized, because an
 * unrecognized vocabulary must be reportable by quoting what was actually seen.
 */
export interface ResolvedSeverity {
  readonly raw: string
  readonly source: SeveritySource
  /**
   * The band a CVSS vector scored to, set only for `source: "cvss-vector"` —
   * `raw` is the vector itself there, which is not a label and would fail
   * `normalizeLabel`. Everywhere else the label IS `raw`, normalized.
   */
  readonly label?: Severity
  /** CVSS vector versions found but not scorable (v2, v4), for the caller's note. */
  readonly unscored?: readonly string[]
}

/** The label a resolution yields, from whichever channel supplied it; "" when unreadable. */
export const severityLabelOf = (sev: ResolvedSeverity): Severity | "" => sev.label ?? normalizeLabel(sev.raw)

export interface OsvPayload {
  readonly report: OsvReport
  /** Which shape was recognized — quoted in the caller's log line. */
  readonly shape: "osv-scanner" | "vuln-list"
  /** Non-fatal facts the caller MUST surface (dropped records, low-confidence version sources, unreadable ratings). */
  readonly notes: readonly string[]
}

/** Discriminated like `Collected` in dependency-scan.ts — narrow with `"error" in result`. */
export type OsvParseResult = OsvPayload | { readonly error: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Read a dotted path (`database_specific.installed`) off an untrusted object; "" when absent or not a non-empty string. */
const readPath = (obj: unknown, dotted: string): string => {
  let cur: unknown = obj
  for (const seg of dotted.split(".")) {
    if (!isRecord(cur)) return ""
    cur = cur[seg]
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : ""
}

/** The `versions[0]` probe — separate from `readPath` because it indexes an array. */
const readFirstVersion = (affected: unknown): string => {
  if (!isRecord(affected)) return ""
  const versions = affected["versions"]
  if (!Array.isArray(versions)) return ""
  const first = versions[0]
  return typeof first === "string" && first.trim() ? first.trim() : ""
}

/** The accepted rating vocabulary, quoted back in the unreadable-rating error. */
const ACCEPTED_LABELS = "low/moderate/medium/high/critical"
/** The full set of channels a rating may arrive on, quoted in the same error. */
const ACCEPTED_CHANNELS = `a ${ACCEPTED_LABELS} label, or a CVSS v3.0/v3.1 vector`

/**
 * Read a record's rating. The company scanner supplies a scalar `severity`
 * string ("HIGH"), which is OFF-SPEC — standard OSV makes `severity` an array
 * of `{type, score}` objects whose `score` is a CVSS VECTOR — so both are
 * accepted, in this order:
 *
 *   1. `severity` as a non-empty string        — the company scanner's shape
 *   2. `database_specific.severity`            — the GHSA-style label osv.ts already reads
 *   3. `severity[]` entries whose `score` is a non-numeric label — worst by
 *      `severityRank` (also off-spec, but seen in the wild)
 *   4. `severity[]` CVSS vectors, scored and banded — the SPEC's own channel,
 *      and the only one a compliant payload is required to carry
 *   5. nothing ⇒ `{ raw: "", source: "none" }`
 *
 * Labels outrank vectors deliberately: a rating the scanner states outright is
 * authoritative over one this code derives, and a site that overrides an
 * advisory's severity does it with the label.
 *
 * A bare NUMBER in `score` is still ignored. It is off-spec, and its CVSS
 * version — hence which qualitative scale it belongs on — is unknowable from
 * the number alone.
 *
 * No vendor-field guessing (`cvss`, `score`, `severity_level`, …): with the
 * rating field known, probing those would only add ways to silently pick up the
 * wrong number. Pure.
 */
export const resolveSeverity = (record: unknown): ResolvedSeverity => {
  if (!isRecord(record)) return { raw: "", source: "none" }

  const scalar = record["severity"]
  if (typeof scalar === "string" && scalar.trim()) return { raw: scalar.trim(), source: "severity" }

  const dbSpecific = readPath(record, "database_specific.severity")
  if (dbSpecific) return { raw: dbSpecific, source: "database_specific" }

  if (!Array.isArray(scalar)) return { raw: "", source: "none" }

  // Standard-OSV `severity[]`, label pass. Worst wins, matching how
  // osvCandidates takes a package's worst.
  let best = ""
  const vectors: { score: string }[] = []
  for (const entry of scalar) {
    const score = isRecord(entry) ? entry["score"] : undefined
    if (typeof score !== "string") continue
    const trimmed = score.trim()
    if (!trimmed) continue
    if (trimmed.includes("/")) {
      vectors.push({ score: trimmed })
      continue
    }
    // A number ("8.1") is not a label.
    if (!Number.isNaN(Number.parseFloat(trimmed))) continue
    if (severityRank(normalizeLabel(trimmed)) > severityRank(normalizeLabel(best))) best = trimmed
  }
  if (best) return { raw: best, source: "severity-array" }

  // Vector pass — the spec's channel. `raw` stays the vector verbatim so an
  // unscorable one can be quoted; `label` carries what it banded to.
  if (vectors.length > 0) {
    const { label, unscored } = bandSeverityVectors(vectors)
    const raw = vectors.map((v) => v.score).join(", ")
    if (label) return { raw, source: "cvss-vector", label, ...(unscored.length > 0 ? { unscored } : {}) }
    return { raw, source: "none", ...(unscored.length > 0 ? { unscored } : {}) }
  }

  return { raw: "", source: "none" }
}

/** One package bucket under construction, before `OsvReportSchema` validates it. */
interface Bucket {
  name: string
  version: string
  ecosystem: string
  vulns: Record<string, unknown>[]
  ids: Set<string>
}

/**
 * Parse a scanner payload into the internal report shape.
 *
 * `opts.ecosystem` (e.g. `"Maven"`), when given, drops vuln-list `affected`
 * entries naming a different OSV ecosystem, with a note — a multi-ecosystem
 * advisory must not leak an npm package into a maven scan. Never applied to the
 * osv-scanner branch, which `-L <file>` already scoped. Pure.
 */
export const parseOsvPayload = (raw: string, opts?: { readonly ecosystem?: string }): OsvParseResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { error: `not valid JSON (${(err as Error).message})` }
  }

  // osv-scanner's own report — the pre-existing path, byte-for-byte. `{}` lands
  // here too (no `results` key ⇒ falls through), so the empty case stays a
  // zero-package report rather than an error, as it always was.
  if (isRecord(parsed) && "results" in parsed) {
    try {
      return { report: OsvReportSchema.parse(parsed), shape: "osv-scanner", notes: [] }
    } catch (err) {
      return { error: `unreadable osv-scanner report (${(err as Error).message})` }
    }
  }
  if (isRecord(parsed) && Object.keys(parsed).length === 0) {
    return { report: OsvReportSchema.parse({}), shape: "osv-scanner", notes: [] }
  }

  const notes: string[] = []
  let records: unknown[]
  if (Array.isArray(parsed)) {
    records = parsed
  } else if (isRecord(parsed)) {
    const key = ["vulns", "vulnerabilities", "findings"].find((k) => Array.isArray(parsed[k]))
    if (!key) {
      return {
        error:
          `no recognized vulnerability list — expected an osv-scanner report ({"results":[…]}), ` +
          `a bare array, or an object with "vulns", "vulnerabilities" or "findings"`,
      }
    }
    records = parsed[key] as unknown[]
    if (key !== "vulns") notes.push(`read the vulnerability list from "${key}"`)
  } else {
    return { error: `expected an object or array at the top level, got ${parsed === null ? "null" : typeof parsed}` }
  }

  const buckets = new Map<string, Bucket>()
  const missingVersion: string[] = []
  const unreadableSeverity: string[] = []
  const unreadableRaw = new Set<string>()
  let seen = 0

  for (const record of records) {
    if (!isRecord(record)) {
      notes.push(`skipped a vulnerability entry that is not an object`)
      continue
    }
    seen++
    const id = typeof record["id"] === "string" && record["id"].trim() ? record["id"].trim() : ""
    const label = id || "(record with no id)"

    const sev = resolveSeverity(record)
    if (sev.source === "none") {
      unreadableSeverity.push(label)
      if (sev.unscored && sev.unscored.length > 0) {
        // A vector WAS present — saying "no severity field" here would send the
        // reader looking for a missing field instead of at an unsupported
        // CVSS version.
        unreadableRaw.add(sev.raw)
        notes.push(
          `${label}: only CVSS v${sev.unscored.join("/v")} vector(s), which are not scored here (v3.0/v3.1 are) — ` +
            `no severity resolved`,
        )
      } else {
        notes.push(`${label}: no severity field — it will fall below every floor`)
      }
    } else if (!severityLabelOf(sev)) {
      unreadableSeverity.push(label)
      unreadableRaw.add(sev.raw)
      notes.push(`${label}: unrecognized severity "${sev.raw}" — expected ${ACCEPTED_LABELS}`)
    }

    const affectedList = Array.isArray(record["affected"]) ? (record["affected"] as unknown[]) : []
    for (const affected of affectedList) {
      if (!isRecord(affected)) continue
      const pkg = isRecord(affected["package"]) ? affected["package"] : {}
      const name = typeof pkg["name"] === "string" ? pkg["name"].trim() : ""
      if (!name) {
        notes.push(`${label}: an affected entry has no package name — skipped`)
        continue
      }
      const ecosystem = typeof pkg["ecosystem"] === "string" ? pkg["ecosystem"].trim() : ""
      if (opts?.ecosystem && ecosystem && ecosystem.toLowerCase() !== opts.ecosystem.toLowerCase()) {
        notes.push(`${label}: ${name} is a ${ecosystem} package — skipped in a ${opts.ecosystem} scan`)
        continue
      }

      let version = ""
      for (const field of INSTALLED_VERSION_FIELDS) {
        version = field === "versions[0]" ? readFirstVersion(affected) : readPath(affected, field)
        if (!version) continue
        if (field === "versions[0]") {
          notes.push(
            `${label}: read ${name}'s installed version "${version}" from the affected-version list — ` +
              `that list holds every affected version, so this may not be what is installed`,
          )
        }
        break
      }
      if (!version) {
        missingVersion.push(`${name} (${label})`)
        notes.push(
          `${label}: ${name} has no readable installed version (probed ${INSTALLED_VERSION_FIELDS.join(", ")}) — skipped`,
        )
        continue
      }

      const key = `${ecosystem}\u0000${name}`
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { name, version, ecosystem, vulns: [], ids: new Set() }
        buckets.set(key, bucket)
      } else if (bucket.version !== version) {
        notes.push(
          `${label}: ${name} reported as ${version} but already seen as ${bucket.version} — keeping ${bucket.version}`,
        )
      }
      if (bucket.ids.has(id) && id) continue
      bucket.ids.add(id)

      // An off-spec LABEL rides out on the one channel osvCandidates reads
      // FIRST, and only when the record left it empty — never clobber a value
      // the scanner supplied, since that field outranks everything downstream.
      //
      // A CVSS vector is deliberately NOT written back: `sev.raw` is the vector
      // itself, which is not a label, and osvCandidates reads `severity[]`
      // directly off the record carried through here. Writing a derived band
      // into `database_specific.severity` would fabricate a field the scanner
      // never emitted — the exact guessing this module avoids.
      const dbSpecific = isRecord(record["database_specific"]) ? record["database_specific"] : {}
      const writeBack =
        sev.source !== "cvss-vector" && sev.raw !== "" && readPath(record, "database_specific.severity") === ""
      bucket.vulns.push(writeBack ? { ...record, database_specific: { ...dbSpecific, severity: sev.raw } } : record)
    }
  }

  if (seen > 0 && missingVersion.length > 0 && buckets.size === 0) {
    return {
      error:
        `${seen} vulnerability record(s), none carrying a readable installed version ` +
        `(probed ${INSTALLED_VERSION_FIELDS.join(", ")}) — the scanner's output shape is not understood`,
    }
  }
  if (seen > 0 && unreadableSeverity.length === seen) {
    const sawList = unreadableRaw.size > 0 ? `saw ${[...unreadableRaw].map((s) => `"${s}"`).join(", ")}; ` : ""
    return {
      error:
        `${seen} vulnerability record(s), none carrying a readable severity — ${sawList}` +
        `expected ${ACCEPTED_CHANNELS}. Every package would sit below the severity floor, ` +
        `so this is reported rather than treated as "no vulnerabilities"`,
    }
  }

  const packages = [...buckets.values()].map((b) => ({
    package: { name: b.name, version: b.version, ecosystem: b.ecosystem },
    vulnerabilities: b.vulns,
    // `groups` stays empty: it is osv-scanner's own precomputed roll-up, which
    // a raw vuln-list has no equivalent of. A rating reaches osvCandidates
    // either as a label written back above or as the record's own `severity[]`
    // vectors, and osvCandidates already tolerates a missing group.
    groups: [],
  }))
  return { report: OsvReportSchema.parse({ results: [{ packages }] }), shape: "vuln-list", notes }
}
