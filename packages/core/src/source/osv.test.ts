import assert from "node:assert/strict"
import { test } from "node:test"
import { bandCvss, compareLooseVersions, osvCandidates, OsvReportSchema } from "./osv.js"

/**
 * The pure OSV-Scanner normalizer: loose version comparison, CVSS banding,
 * and the report → UpgradeCandidate reduction (max-of-minimal-fixes, severity
 * resolution order, floor/major/transitive/unfixable partitions). The
 * dependency-scan source tests cover how these feed claims end-to-end.
 */

const POLICY = { severityFloor: "high", autoFix: ["patch", "minor"] }
const ALL_DECLARED = () => true

/** One OSV package entry: vulnerabilities with fixed events + a covering group. */
const osvPackage = (
  name: string,
  version: string,
  vulns: { id: string; label?: string; fixed?: string[] }[],
  maxSeverity = "",
) => ({
  package: { name, version, ecosystem: "Maven" },
  vulnerabilities: vulns.map((v) => ({
    id: v.id,
    ...(v.label ? { database_specific: { severity: v.label } } : {}),
    affected: [
      {
        package: { name, ecosystem: "Maven" },
        ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, ...(v.fixed ?? []).map((f) => ({ fixed: f }))] }],
      },
    ],
  })),
  groups: [{ ids: vulns.map((v) => v.id), aliases: [], ...(maxSeverity ? { max_severity: maxSeverity } : {}) }],
})

const report = (...packages: unknown[]) => OsvReportSchema.parse({ results: [{ packages }] })

test("compareLooseVersions orders JVM-style versions", () => {
  assert.ok(compareLooseVersions("2.9.10.8", "2.9.10") > 0)
  assert.ok(compareLooseVersions("2.9.10", "2.9.10.8") < 0)
  assert.equal(compareLooseVersions("2.9.10", "2.9.10.0"), 0)
  assert.ok(compareLooseVersions("5.3.39", "5.3.4") > 0) // numeric, not lexicographic
  assert.ok(compareLooseVersions("1.2.4.RELEASE", "1.2.3.RELEASE") > 0)
  assert.ok(compareLooseVersions("2.0.0", "2.0.0-M1") > 0) // release beats milestone
  assert.ok(compareLooseVersions("2.0.0-M1", "2.0.0-M2") < 0)
  assert.equal(compareLooseVersions("v1.2.3", "1.2.3"), 0)
})

test("bandCvss bands numeric strings at the 4/7/9 boundaries and rejects garbage", () => {
  assert.equal(bandCvss("0"), "low")
  assert.equal(bandCvss("3.9"), "low")
  assert.equal(bandCvss("4.0"), "moderate")
  assert.equal(bandCvss("6.9"), "moderate")
  assert.equal(bandCvss("7.0"), "high")
  assert.equal(bandCvss("8.9"), "high")
  assert.equal(bandCvss("9.0"), "critical")
  assert.equal(bandCvss("10.0"), "critical")
  assert.equal(bandCvss(""), "")
  assert.equal(bandCvss("CVSS:3.1/AV:N"), "")
})

test("target is the max of per-vuln minimal fixes — one bump clears every vulnerability", () => {
  const r = report(
    osvPackage("com.fasterxml.jackson.core:jackson-databind", "2.9.10", [
      // Minimal fix above current is 2.9.10.4 (the 2.9.9 fix is below current — already applied).
      { id: "GHSA-1", label: "HIGH", fixed: ["2.9.9", "2.9.10.4", "2.10.0"] },
      // This vuln needs 2.9.10.8 — the package target must be the max: 2.9.10.8.
      { id: "GHSA-2", label: "CRITICAL", fixed: ["2.9.10.8"] },
    ]),
  )
  const { claimable } = osvCandidates(r, POLICY, ALL_DECLARED, "maven")
  assert.equal(claimable.length, 1)
  assert.equal(claimable[0]?.pkg, "com.fasterxml.jackson.core:jackson-databind")
  assert.equal(claimable[0]?.target, "2.9.10.8")
  assert.equal(claimable[0]?.severity, "critical") // worst across vulns
  assert.equal(claimable[0]?.impact, "patch")
  assert.equal(claimable[0]?.ecosystem, "maven")
})

test("severity resolution: label first (MODERATE and MEDIUM both normalize), else the group's banded max_severity", () => {
  const labeled = report(osvPackage("g:a", "1.0.0", [{ id: "V1", label: "MODERATE", fixed: ["1.0.1"] }]))
  const medium = report(osvPackage("g:b", "1.0.0", [{ id: "V2", label: "MEDIUM", fixed: ["1.0.1"] }]))
  const banded = report(osvPackage("g:c", "1.0.0", [{ id: "V3", fixed: ["1.0.1"] }], "8.1"))
  const low = { severityFloor: "low", autoFix: ["patch", "minor"] }
  assert.equal(osvCandidates(labeled, low, ALL_DECLARED, "maven").claimable[0]?.severity, "moderate")
  assert.equal(osvCandidates(medium, low, ALL_DECLARED, "maven").claimable[0]?.severity, "moderate")
  assert.equal(osvCandidates(banded, low, ALL_DECLARED, "maven").claimable[0]?.severity, "high")
})

test("the severity floor drops below-floor and severity-unresolvable packages silently", () => {
  const r = report(
    osvPackage("g:low", "1.0.0", [{ id: "V1", label: "LOW", fixed: ["1.0.1"] }]),
    // No label, no max_severity — unresolvable, never claimed under any floor.
    osvPackage("g:unknown", "1.0.0", [{ id: "V2", fixed: ["1.0.1"] }]),
    osvPackage("g:crit", "1.0.0", [{ id: "V3", label: "CRITICAL", fixed: ["1.0.1"] }]),
  )
  const judged = osvCandidates(r, POLICY, ALL_DECLARED, "maven")
  assert.deepEqual(judged.claimable.map((c) => c.pkg), ["g:crit"])
  assert.equal(judged.skippedMajors.length + judged.skippedTransitives.length + judged.unfixable.length, 0)
})

test("a vulnerability with no fixed version above current makes the package unfixable — never claimed", () => {
  const r = report(
    osvPackage("g:stuck", "2.0.0", [
      { id: "V1", label: "CRITICAL", fixed: ["2.0.1"] },
      { id: "V2", label: "HIGH", fixed: [] }, // no fix exists
    ]),
  )
  const judged = osvCandidates(r, POLICY, ALL_DECLARED, "maven")
  assert.equal(judged.claimable.length, 0)
  assert.deepEqual(judged.unfixable.map((c) => c.pkg), ["g:stuck"])
})

test("majors and unparsable current versions are skipped-not-claimed; undeclared packages are transitives", () => {
  const r = report(
    osvPackage("g:major", "1.9.0", [{ id: "V1", label: "CRITICAL", fixed: ["2.0.0"] }]),
    osvPackage("g:weird", "unknown-version", [{ id: "V2", label: "CRITICAL", fixed: ["9.9.9"] }]),
    osvPackage("g:transitive", "1.0.0", [{ id: "V3", label: "CRITICAL", fixed: ["1.0.1"] }]),
    osvPackage("g:direct", "1.0.0", [{ id: "V4", label: "HIGH", fixed: ["1.0.1"] }]),
  )
  const judged = osvCandidates(r, POLICY, (pkg) => pkg !== "g:transitive", "maven")
  assert.deepEqual(judged.claimable.map((c) => c.pkg), ["g:direct"])
  assert.deepEqual(judged.skippedMajors.map((c) => c.pkg).sort(), ["g:major", "g:weird"])
  assert.deepEqual(judged.skippedTransitives.map((c) => c.pkg), ["g:transitive"])
})

test("claimable candidates come back severity-first then by name — the npm ordering", () => {
  const low = { severityFloor: "low", autoFix: ["patch", "minor"] }
  const r = report(
    osvPackage("g:bbb", "1.0.0", [{ id: "V1", label: "HIGH", fixed: ["1.0.1"] }]),
    osvPackage("g:aaa", "1.0.0", [{ id: "V2", label: "HIGH", fixed: ["1.0.1"] }]),
    osvPackage("g:zzz", "1.0.0", [{ id: "V3", label: "CRITICAL", fixed: ["1.0.1"] }]),
  )
  assert.deepEqual(
    osvCandidates(r, low, ALL_DECLARED, "gradle").claimable.map((c) => c.pkg),
    ["g:zzz", "g:aaa", "g:bbb"],
  )
})

test("affected entries for OTHER packages never contribute fixes", () => {
  const r = OsvReportSchema.parse({
    results: [
      {
        packages: [
          {
            package: { name: "g:mine", version: "1.0.0", ecosystem: "Maven" },
            vulnerabilities: [
              {
                id: "V1",
                database_specific: { severity: "HIGH" },
                affected: [
                  // A multi-package advisory: the other package's fix must not leak in.
                  { package: { name: "g:other", ecosystem: "Maven" }, ranges: [{ type: "ECOSYSTEM", events: [{ fixed: "9.9.9" }] }] },
                  { package: { name: "g:mine", ecosystem: "Maven" }, ranges: [{ type: "ECOSYSTEM", events: [{ fixed: "1.0.2" }] }] },
                ],
              },
            ],
            groups: [{ ids: ["V1"] }],
          },
        ],
      },
    ],
  })
  const { claimable } = osvCandidates(r, POLICY, ALL_DECLARED, "maven")
  assert.equal(claimable[0]?.target, "1.0.2")
})
