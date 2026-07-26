import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { test } from "node:test"
import { INSTALLED_VERSION_FIELDS, parseOsvPayload, resolveSeverity } from "./osv-payload.js"
import { osvCandidates, OsvReportSchema } from "./osv.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(path.join(here, "__fixtures__", "corp-scan.json"), "utf8")

const POLICY = { severityFloor: "high", autoFix: ["patch", "minor"] as const }
const ok = (result: ReturnType<typeof parseOsvPayload>) => {
  assert.ok(!("error" in result), `expected a parsed payload, got error: ${"error" in result ? result.error : ""}`)
  return result as Exclude<typeof result, { error: string }>
}
const err = (result: ReturnType<typeof parseOsvPayload>): string => {
  assert.ok("error" in result, "expected an error result")
  return (result as { error: string }).error
}

/** A minimal vuln-list record in the documented contract; `over` patches any field. */
const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "CVE-2024-0001",
  severity: "HIGH",
  affected: [
    {
      package: { name: "com.acme:widget", ecosystem: "Maven", version: "1.2.3" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.2.4" }] }],
    },
  ],
  ...over,
})

// --- the fixture: the contract, pinned against a file a site can replace ---

test("the committed fixture parses into the documented candidates", () => {
  const payload = ok(parseOsvPayload(fixture, { ecosystem: "Maven" }))
  assert.equal(payload.shape, "vuln-list")

  const judged = osvCandidates(payload.report, POLICY, () => true, "maven")
  const byPkg = Object.fromEntries(judged.claimable.map((c) => [c.pkg, c]))

  // jackson-databind is named by TWO advisories; one bump must clear both, so
  // the target is the MAX of each advisory's minimal fix above current.
  assert.deepEqual(
    { ...byPkg["com.fasterxml.jackson.core:jackson-databind"] },
    {
      pkg: "com.fasterxml.jackson.core:jackson-databind",
      current: "2.13.4",
      target: "2.13.5",
      impact: "patch",
      severity: "critical",
      ecosystem: "maven",
    },
  )
  // snakeyaml 1.33 → 2.0 is a MAJOR: reported, never auto-claimed.
  assert.equal(byPkg["org.yaml:snakeyaml"], undefined, "a major bump is not claimable")
  assert.deepEqual(
    judged.skippedMajors.map((c) => `${c.pkg} ${c.current}→${c.target}`),
    ["org.yaml:snakeyaml 1.33→2.0"],
  )

  // An advisory with no `fixed` above current has nothing to upgrade to.
  assert.deepEqual(
    judged.unfixable.map((c) => c.pkg),
    ["org.example:unpatched"],
  )
  assert.deepEqual(payload.notes, [], "a contract-shaped payload produces no notes")
})

// --- resolveSeverity: one test per accepted encoding ---

test("resolveSeverity reads the company scanner's scalar severity string", () => {
  assert.deepEqual(resolveSeverity({ severity: "HIGH" }), { raw: "HIGH", source: "severity" })
  assert.deepEqual(resolveSeverity({ severity: "  critical  " }), { raw: "critical", source: "severity" })
})

test("resolveSeverity falls back to database_specific.severity", () => {
  assert.deepEqual(resolveSeverity({ database_specific: { severity: "MODERATE" } }), {
    raw: "MODERATE",
    source: "database_specific",
  })
})

test("resolveSeverity takes the worst label from a standard-OSV severity array", () => {
  const resolved = resolveSeverity({
    severity: [{ type: "VENDOR", score: "moderate" }, { type: "VENDOR", score: "critical" }, { score: "low" }],
  })
  assert.deepEqual(resolved, { raw: "critical", source: "severity-array" })
})

test("resolveSeverity ignores CVSS vectors and numbers rather than scoring them", () => {
  const vectorsOnly = {
    severity: [
      { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
      { type: "CVSS_V2", score: "8.1" },
    ],
  }
  assert.deepEqual(resolveSeverity(vectorsOnly), { raw: "", source: "none" })
})

test("resolveSeverity prefers the scalar severity over a disagreeing database_specific", () => {
  const resolved = resolveSeverity({ severity: "CRITICAL", database_specific: { severity: "LOW" } })
  assert.deepEqual(resolved, { raw: "CRITICAL", source: "severity" })
})

test("resolveSeverity reports absent, empty and non-string ratings as none", () => {
  for (const r of [{}, { severity: "" }, { severity: "   " }, { severity: null }, { severity: 8.1 }, null, "nope"]) {
    assert.equal(resolveSeverity(r).source, "none", `expected none for ${JSON.stringify(r)}`)
  }
})

// --- vocabulary ---

test("the accepted vocabulary is case-insensitive and aliases medium to moderate", () => {
  const judge = (severity: string) => {
    const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record({ severity })] })))
    return osvCandidates(payload.report, { severityFloor: "low", autoFix: ["patch"] }, () => true, "maven")
      .claimable[0]?.severity
  }
  assert.equal(judge("HIGH"), "high")
  assert.equal(judge("high"), "high")
  assert.equal(judge("Medium"), "moderate")
  assert.equal(judge("CRITICAL"), "critical")
})

test("an unrecognized rating is noted with the raw value quoted", () => {
  const payload = ok(
    parseOsvPayload(JSON.stringify({ vulns: [record({ severity: "ELEVATED" }), record({ id: "CVE-2", severity: "HIGH" })] })),
  )
  const note = payload.notes.find((n) => n.includes("unrecognized severity"))
  assert.ok(note, `expected an unrecognized-severity note, got ${JSON.stringify(payload.notes)}`)
  assert.match(note, /"ELEVATED"/)
  assert.match(note, /low\/moderate\/medium\/high\/critical/)
})

test("a payload whose every rating is unreadable is an error quoting what was seen", () => {
  const message = err(
    parseOsvPayload(JSON.stringify({ vulns: [record({ severity: "ELEVATED" }), record({ id: "CVE-2", severity: "SEV1" })] })),
  )
  assert.match(message, /"ELEVATED"/)
  assert.match(message, /"SEV1"/)
  assert.match(message, /low\/moderate\/medium\/high\/critical/)
})

test("a payload whose every record lacks a severity field is an error, not a zero", () => {
  const stripped = record()
  delete stripped["severity"]
  const message = err(parseOsvPayload(JSON.stringify({ vulns: [stripped] })))
  assert.match(message, /none carrying a readable severity/)
})

// --- envelope recognition ---

test("an osv-scanner report passes through unchanged", () => {
  const report = {
    results: [
      {
        packages: [
          {
            package: { name: "com.acme:widget", version: "1.2.3", ecosystem: "Maven" },
            vulnerabilities: [{ id: "CVE-1", affected: [] }],
            groups: [{ ids: ["CVE-1"], aliases: [], max_severity: "9.1" }],
          },
        ],
      },
    ],
  }
  const payload = ok(parseOsvPayload(JSON.stringify(report)))
  assert.equal(payload.shape, "osv-scanner")
  assert.deepEqual(payload.report, OsvReportSchema.parse(report))
  assert.deepEqual(payload.notes, [])
})

test("an empty object stays a zero-package osv-scanner report (backward-compat pin)", () => {
  const payload = ok(parseOsvPayload("{}"))
  assert.equal(payload.shape, "osv-scanner")
  assert.deepEqual(payload.report, OsvReportSchema.parse({}))
  assert.deepEqual(payload.notes, [])
})

test("every documented envelope yields the same one package", () => {
  const one = [record()]
  for (const raw of [
    JSON.stringify({ vulns: one }),
    JSON.stringify({ vulnerabilities: one }),
    JSON.stringify({ findings: one }),
    JSON.stringify(one),
  ]) {
    const payload = ok(parseOsvPayload(raw))
    assert.equal(payload.shape, "vuln-list")
    assert.equal(payload.report.results[0]?.packages[0]?.package.name, "com.acme:widget")
  }
})

test("a non-default list key is noted so the choice is visible", () => {
  const payload = ok(parseOsvPayload(JSON.stringify({ findings: [record()] })))
  assert.ok(payload.notes.some((n) => n.includes('"findings"')))
})

// --- installed-version probe ---

test("every INSTALLED_VERSION_FIELDS entry resolves the installed version", () => {
  const affectedFor = (field: string): Record<string, unknown> => {
    const base = { package: { name: "com.acme:widget", ecosystem: "Maven" }, ranges: [{ events: [{ fixed: "1.2.4" }] }] }
    if (field === "package.version") return { ...base, package: { ...base.package, version: "1.2.3" } }
    if (field === "versions[0]") return { ...base, versions: ["1.2.3", "1.2.2"] }
    return { ...base, database_specific: { [field.split(".")[1]!]: "1.2.3" } }
  }
  for (const field of INSTALLED_VERSION_FIELDS) {
    const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record({ affected: [affectedFor(field)] })] })))
    assert.equal(
      payload.report.results[0]?.packages[0]?.package.version,
      "1.2.3",
      `expected ${field} to resolve the installed version`,
    )
  }
})

test("reading the version from the affected-version list is flagged as low confidence", () => {
  const affected = {
    package: { name: "com.acme:widget", ecosystem: "Maven" },
    versions: ["1.2.3"],
    ranges: [{ events: [{ fixed: "1.2.4" }] }],
  }
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record({ affected: [affected] })] })))
  assert.ok(payload.notes.some((n) => n.includes("affected-version list")))
})

test("a record with no readable installed version is noted, and the rest still claim", () => {
  const versionless = {
    id: "CVE-NOVER",
    severity: "HIGH",
    affected: [{ package: { name: "com.acme:mystery", ecosystem: "Maven" }, ranges: [{ events: [{ fixed: "9.9" }] }] }],
  }
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [versionless, record()] })))
  const note = payload.notes.find((n) => n.includes("no readable installed version"))
  assert.ok(note)
  assert.match(note, /com\.acme:mystery/)
  assert.match(note, /CVE-NOVER/)
  assert.equal(payload.report.results[0]?.packages.length, 1, "the healthy record still produced a package")
})

test("a payload where no record carries an installed version is an error", () => {
  const versionless = {
    id: "CVE-NOVER",
    severity: "HIGH",
    affected: [{ package: { name: "com.acme:mystery", ecosystem: "Maven" }, ranges: [{ events: [{ fixed: "9.9" }] }] }],
  }
  const message = err(parseOsvPayload(JSON.stringify({ vulns: [versionless] })))
  assert.match(message, /none carrying a readable installed version/)
  assert.match(message, /package\.version/)
})

test("a conflicting installed version keeps the first and notes the disagreement", () => {
  const second = record({
    id: "CVE-2",
    affected: [
      {
        package: { name: "com.acme:widget", ecosystem: "Maven", version: "9.9.9" },
        ranges: [{ events: [{ fixed: "9.9.10" }] }],
      },
    ],
  })
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record(), second] })))
  assert.equal(payload.report.results[0]?.packages[0]?.package.version, "1.2.3")
  assert.ok(payload.notes.some((n) => n.includes("already seen as 1.2.3")))
})

// --- grouping, and the structural claim ---

test("a vuln-list rating reaches the unmodified osvCandidates", () => {
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record({ severity: "CRITICAL" })] })))
  const judged = osvCandidates(payload.report, POLICY, () => true, "maven")
  assert.equal(judged.claimable.length, 1)
  assert.equal(judged.claimable[0]?.severity, "critical")
  assert.equal(judged.claimable[0]?.current, "1.2.3")
  assert.equal(judged.claimable[0]?.target, "1.2.4")
})

test("a record's own database_specific.severity is never clobbered", () => {
  const both = record({ severity: "CRITICAL", database_specific: { severity: "MODERATE" } })
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [both] })))
  const judged = osvCandidates(payload.report, { severityFloor: "low", autoFix: ["patch"] }, () => true, "maven")
  assert.equal(judged.claimable[0]?.severity, "moderate", "the record's own label outranks the resolved scalar")
})

test("a multi-package record yields one candidate per package, each keeping the full affected array", () => {
  const multi = {
    id: "CVE-MULTI",
    severity: "HIGH",
    affected: [
      {
        package: { name: "com.acme:one", ecosystem: "Maven", version: "1.0.0" },
        ranges: [{ events: [{ fixed: "1.0.1" }] }],
      },
      {
        package: { name: "com.acme:two", ecosystem: "Maven", version: "2.0.0" },
        ranges: [{ events: [{ fixed: "2.0.1" }] }],
      },
    ],
  }
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [multi] })))
  const packages = payload.report.results[0]?.packages ?? []
  assert.equal(packages.length, 2)
  for (const p of packages) assert.equal(p.vulnerabilities[0]?.affected.length, 2, "the full affected array rides along")

  const judged = osvCandidates(payload.report, POLICY, () => true, "maven")
  assert.deepEqual(
    judged.claimable.map((c) => `${c.pkg}@${c.target}`),
    ["com.acme:one@1.0.1", "com.acme:two@2.0.1"],
    "each package reads fixes only from the affected entry naming it",
  )
})

test("two advisories on one package produce one candidate at the max of their minimal fixes", () => {
  const second = record({
    id: "CVE-2",
    affected: [
      {
        package: { name: "com.acme:widget", ecosystem: "Maven", version: "1.2.3" },
        ranges: [{ events: [{ fixed: "1.5.0" }] }],
      },
    ],
  })
  const payload = ok(parseOsvPayload(JSON.stringify({ vulns: [record(), second] })))
  const packages = payload.report.results[0]?.packages ?? []
  assert.equal(packages.length, 1)
  assert.equal(packages[0]?.vulnerabilities.length, 2)
  assert.deepEqual(packages[0]?.groups, [], "no synthetic groups — the rating rides the label channel")

  const judged = osvCandidates(payload.report, POLICY, () => true, "maven")
  assert.equal(judged.claimable[0]?.target, "1.5.0")
})

// --- ecosystem filter ---

test("the ecosystem filter drops a foreign package with a note, and is off by default", () => {
  const foreign = record({
    id: "CVE-NPM",
    affected: [{ package: { name: "lodash", ecosystem: "npm", version: "4.17.20" }, ranges: [{ events: [{ fixed: "4.17.21" }] }] }],
  })
  const filtered = ok(parseOsvPayload(JSON.stringify({ vulns: [record(), foreign] }), { ecosystem: "Maven" }))
  assert.equal(filtered.report.results[0]?.packages.length, 1)
  assert.ok(filtered.notes.some((n) => n.includes("skipped in a Maven scan")))

  const unfiltered = ok(parseOsvPayload(JSON.stringify({ vulns: [record(), foreign] })))
  assert.equal(unfiltered.report.results[0]?.packages.length, 2)
})

// --- malformed input ---

test("unparsable and non-collection payloads are errors", () => {
  assert.match(err(parseOsvPayload("not json")), /not valid JSON/)
  assert.match(err(parseOsvPayload("null")), /expected an object or array/)
  assert.match(err(parseOsvPayload("42")), /expected an object or array/)
  assert.match(err(parseOsvPayload('"str"')), /expected an object or array/)
  assert.match(err(parseOsvPayload('{"other":[]}')), /no recognized vulnerability list/)
})
