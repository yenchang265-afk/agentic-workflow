import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import {
  depKey,
  detectEcosystems,
  makeDependencyScanSource,
  renderScannerCommand,
  semverImpact,
  upgradeCandidates,
} from "./dependency-scan.js"

/**
 * The dependency-scan source over the real dep-sitter manifest, against a
 * scripted npm shell. The candidate policy (floor, majors, outdated merge) is
 * covered on the pure `upgradeCandidates`; the source tests cover polling,
 * ledger dedup, claim mechanics, and terminal ledger writes.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const sitter = loadManifest(WORKFLOWS_DIR, "dep-sitter")

// Ledger/claim/work-item keys, derived exactly as the source derives them.
const LODASH = depKey("lodash")
const JACKSON_KEY = depKey("com.fasterxml.jackson.core:jackson-databind")
const LOGBACK_KEY = depKey("ch.qos.logback:logback-classic")
const SPRING_KEY = depKey("org.springframework:spring-web")

test("depKey disambiguates packages whose slugs collide", () => {
  // slugify collapses both to "babel-core"; a shared key would let one
  // package's ledger suppress the other's security upgrade.
  assert.notEqual(depKey("@babel/core"), depKey("babel-core"))
  assert.match(depKey("@babel/core"), /^dep-babel-core-[0-9a-f]{8}$/)
  assert.equal(depKey("lodash"), depKey("lodash"), "stable across calls")
})

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

/** Scripted shell: first matching prefix wins; unmatched commands succeed empty. */
const scriptedShell = (script: Cmd[], log: string[] = []): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      // A `{ raw }` interpolation splices in unescaped, matching Bun's `$` and
      // the Claude host's shim. Without this branch a raw splice renders
      // "[object Object]" and every scannerCommand test would silently pass
      // against a command nobody ran.
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += typeof e === "object" && e !== null && "raw" in e ? String((e as { raw: unknown }).raw) : String(e)
      }
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log.push(cmd)
    const hit = script.find((c) => cmd.startsWith(c.cmd))
    const r = hit?.result ?? { exitCode: 0, stdout: "" }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

/** Client whose reads serve ledger files from an in-memory map. */
const ledgerClient = (ledgers: Record<string, string>): Client => ({
  file: {
    async list() {
      return { data: [] }
    },
    async read({ query }) {
      const content = ledgers[query.path]
      return { data: content ? { content } : null }
    },
  },
  app: { async log() {} },
})

const vuln = (over: Record<string, unknown> = {}) => ({
  name: "lodash",
  severity: "high",
  isDirect: true,
  fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
  ...over,
})

const audit = (vulns: Record<string, unknown>) => JSON.stringify({ vulnerabilities: vulns })
const installed = (deps: Record<string, string>) =>
  JSON.stringify({ dependencies: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { version: v }])) })

const POLICY = { severityFloor: "high", autoFix: ["patch", "minor"], includeOutdated: false }

test("semverImpact classifies bumps and treats unparsable versions as major", () => {
  assert.equal(semverImpact("1.2.3", "1.2.4"), "patch")
  assert.equal(semverImpact("1.2.3", "1.3.0"), "minor")
  assert.equal(semverImpact("1.2.3", "2.0.0"), "major")
  assert.equal(semverImpact("", "1.2.3"), "major")
  assert.equal(semverImpact("next", "1.2.3"), "major")
})

test("upgradeCandidates enforces the severity floor, directness, and the majors-stay-human rule", () => {
  const report = {
    vulnerabilities: {
      lodash: vuln({}),
      // Below the floor.
      chalk: vuln({ name: "chalk", severity: "moderate", fixAvailable: { name: "chalk", version: "5.0.1", isSemVerMajor: false } }),
      // Transitive — npm audit fix territory, not a claimable direct upgrade.
      minimist: vuln({ name: "minimist", isDirect: false }),
      // Major: surfaced, never claimed.
      express: vuln({ name: "express", severity: "critical", fixAvailable: { name: "express", version: "5.0.0", isSemVerMajor: true } }),
      // fixAvailable=true carries no target version — nothing actionable to pin.
      needsfix: vuln({ name: "needsfix", fixAvailable: true }),
    },
  }
  const { claimable, skippedMajors } = upgradeCandidates(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    report as any,
    { lodash: "4.17.20", express: "4.18.0" },
    {},
    POLICY,
  )
  assert.deepEqual(claimable.map((c) => c.pkg), ["lodash"])
  assert.equal(claimable[0]?.impact, "patch")
  assert.deepEqual(skippedMajors.map((c) => c.pkg), ["express"])
})

test("upgradeCandidates merges outdated deps when enabled, vulnerable candidates winning and severity ordering first", () => {
  const report = { vulnerabilities: { lodash: vuln({}) } }
  const outdated = {
    lodash: { current: "4.17.20", wanted: "4.17.99" }, // already a vulnerable candidate — audit wins
    zod: { current: "3.22.0", wanted: "3.23.0" }, // minor — claimable
    react: { current: "17.0.0", wanted: "18.0.0" }, // major — never
  }
  const { claimable } = upgradeCandidates(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    report as any,
    { lodash: "4.17.20" },
    outdated,
    { ...POLICY, includeOutdated: true },
  )
  assert.deepEqual(claimable.map((c) => c.pkg), ["lodash", "zod"])
  assert.equal(claimable[0]?.target, "4.17.21")
  assert.equal(claimable[1]?.severity, "")
})

const source = (opts: { auditJson?: string; lsJson?: string; ledgers?: Record<string, string>; script?: Cmd[]; log?: string[]; warnings?: string[] } = {}) =>
  makeDependencyScanSource({
    $: scriptedShell(
      [
        { cmd: "npm audit --json", result: { exitCode: 1, stdout: opts.auditJson ?? audit({ lodash: vuln({}) }) } },
        { cmd: "npm ls --json", result: { stdout: opts.lsJson ?? installed({ lodash: "4.17.20" }) } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    // package.json makes ecosystem auto-detection resolve to npm, the original fixture shape.
    client: ledgerClient({ "package.json": "{}", ...(opts.ledgers ?? {}) }),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void opts.warnings?.push(m),
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims a fixable advisory: scan entry, feature-branch goal, claims under runs/dep-sitter", async () => {
  const log: string[] = []
  const { item, skip } = await source({ log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, LODASH)
  assert.equal(item?.entryStage, "scan")
  assert.equal(item?.state.kind, "dep-sitter")
  assert.equal(item?.state.git, undefined)
  assert.match(item?.state.goal ?? "", /^Upgrade lodash to 4\.17\.21/)
  assert.match(item?.state.goal ?? "", /DRAFT pull request/)
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.includes(`runs/dep-sitter/.claims/${LODASH}`)))
})

test("a major-only report claims nothing and logs the human handoff", async () => {
  const warnings: string[] = []
  const majorOnly = audit({
    express: vuln({ name: "express", severity: "critical", fixAvailable: { name: "express", version: "5.0.0", isSemVerMajor: true } }),
  })
  const { item, skip } = await source({ auditJson: majorOnly, warnings }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /^dep-sitter: no auto-fixable upgrades/)
  assert.equal(skip?.actionable, false)
  assert.ok(warnings.some((w) => w.includes("express") && w.includes("majors stay a human call")))
})

test("a handled or failed target suppresses the claim until the target moves", async () => {
  const handled = {
    [`docs/tasks/runs/dep-sitter/${LODASH}.json`]: JSON.stringify({
      pkg: "lodash",
      versionHandled: "4.17.21",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: handled }).claimNext()).item, null)
  const failed = {
    [`docs/tasks/runs/dep-sitter/${LODASH}.json`]: JSON.stringify({
      pkg: "lodash",
      failedAttempts: [{ target: "4.17.21", at: "2026-07-04T00:00:00Z" }],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: failed }).claimNext()).item, null)
  // A newer fix version is a fresh claim.
  const newer = audit({ lodash: vuln({ fixAvailable: { name: "lodash", version: "4.17.22", isSemVerMajor: false } }) })
  assert.equal((await source({ ledgers: handled, auditJson: newer }).claimNext()).item?.id, LODASH)
})

test("onTerminal(done) records the published target; stop records a failed attempt", async () => {
  const log: string[] = []
  const src = source({ log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "draft PR opened" })
  const write = log.find((c) => c.startsWith("printf") && c.includes(`${LODASH}.json`))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /versionHandled/)
  assert.match(write ?? "", /4\.17\.21/)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes(LODASH)))
})

test("onTerminal: a genuine stop records a failed attempt; a retryable (onError) stop does not (C2)", async () => {
  const genuine: string[] = []
  const g = source({ log: genuine })
  const c1 = await g.claimNext()
  assert.ok(c1.item)
  await g.onTerminal?.(c1.item, { kind: "stop", message: "capped" })
  const gWrite = genuine.find((c) => c.startsWith("printf") && c.includes(`${LODASH}.json`))
  assert.match(gWrite ?? "", /failedAttempts/, "genuine stop records a failed attempt")

  const transient: string[] = []
  const t = source({ log: transient })
  const c2 = await t.claimNext()
  assert.ok(c2.item)
  await t.onTerminal?.(c2.item, { kind: "stop", message: "osv-scanner unavailable", retryable: true })
  assert.ok(
    !transient.some((c) => c.startsWith("printf") && c.includes(`${LODASH}.json`)),
    "retryable stop leaves the ledger untouched so the next poll re-claims",
  )
  assert.ok(transient.some((c) => c.startsWith("rmdir") && c.includes(LODASH)), "claim marker still released")
})

test("an unparsable audit report is an actionable skip, not a crash", async () => {
  const { item, skip } = await source({ auditJson: "not json" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /^dep-sitter: could not parse npm audit output/)
  assert.equal(skip?.actionable, true)
})

test("the claimed item is stamped with the resolved platform; defaults to github", () => {
  return (async () => {
    const defaulted = await source({}).claimNext()
    assert.equal(defaulted.item?.state.platform, "github")
    const adoSrc = makeDependencyScanSource({
      $: scriptedShell([
        { cmd: "npm audit --json", result: { exitCode: 1, stdout: audit({ lodash: vuln({}) }) } },
        { cmd: "npm ls --json", result: { stdout: installed({ lodash: "4.17.20" }) } },
      ]),
      client: ledgerClient({ "package.json": "{}" }),
      directory: "/r",
      tasksDir: "docs/tasks",
      log: () => {},
      loaded: sitter,
      platform: "ado",
      now: () => "2026-07-05T00:00:00Z",
    })
    const ado = await adoSrc.claimNext()
    assert.equal(ado.item?.state.platform, "ado")
  })()
})

// --- the JVM ecosystems: detection, OSV-driven maven/gradle flows, merge semantics ---

const POM = `<project><dependencies><dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.9.10</version></dependency></dependencies></project>`

/** One-vuln-per-package OSV report, matching the osv-scanner --format json shape. */
const osvReport = (pkgs: { name: string; version: string; severity: string; fixed: string }[]) =>
  JSON.stringify({
    results: [
      {
        packages: pkgs.map((p) => ({
          package: { name: p.name, version: p.version, ecosystem: "Maven" },
          vulnerabilities: [
            {
              id: `V-${p.name}`,
              database_specific: { severity: p.severity },
              affected: [
                {
                  package: { name: p.name, ecosystem: "Maven" },
                  ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: p.fixed }] }],
                },
              ],
            },
          ],
          groups: [{ ids: [`V-${p.name}`] }],
        })),
      },
    ],
  })

const JACKSON = osvReport([
  { name: "com.fasterxml.jackson.core:jackson-databind", version: "2.9.10", severity: "HIGH", fixed: "2.9.10.8" },
])

const OSV_OK: Cmd = { cmd: "osv-scanner --version", result: { stdout: "osv-scanner version: 2.0.0\n" } }

const ecoSource = (opts: {
  files?: Record<string, string>
  script?: Cmd[]
  log?: string[]
  warnings?: string[]
  ecosystem?: string
  scannerCommand?: string
} = {}) =>
  makeDependencyScanSource({
    $: scriptedShell(opts.script ?? [], opts.log),
    client: ledgerClient(opts.files ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void opts.warnings?.push(m),
    loaded: sitter,
    ...(opts.ecosystem ? { ecosystem: opts.ecosystem } : {}),
    ...(opts.scannerCommand ? { scannerCommand: opts.scannerCommand } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

/** A vuln-list payload in the documented contract — what a site's own CLI emits. */
const vulnList = (pkgs: { name: string; version: string; severity: string; fixed?: string }[]) =>
  JSON.stringify({
    vulns: pkgs.map((p) => ({
      id: `V-${p.name}`,
      severity: p.severity,
      affected: [
        {
          package: { name: p.name, ecosystem: "Maven", version: p.version },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, ...(p.fixed ? [{ fixed: p.fixed }] : [])] }],
        },
      ],
    })),
  })

const JACKSON_VULN_LIST = vulnList([
  { name: "com.fasterxml.jackson.core:jackson-databind", version: "2.9.10", severity: "HIGH", fixed: "2.9.10.8" },
])

test("detectEcosystems probes the manifest files", async () => {
  const probe = (present: string[]) => (rel: string) => Promise.resolve(present.includes(rel))
  assert.deepEqual(await detectEcosystems(probe(["package.json"])), ["npm"])
  assert.deepEqual(await detectEcosystems(probe(["pom.xml"])), ["maven"])
  assert.deepEqual(await detectEcosystems(probe(["build.gradle.kts"])), ["gradle"])
  assert.deepEqual(await detectEcosystems(probe(["package.json", "pom.xml", "build.gradle"])), ["npm", "maven", "gradle"])
  assert.deepEqual(await detectEcosystems(probe([])), [])
})

test("a maven repo claims an OSV advisory: -L pom.xml scan, maven work order, claims under runs/dep-sitter", async () => {
  const log: string[] = []
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM },
    script: [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: JACKSON } }],
    log,
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, JACKSON_KEY)
  assert.equal(item?.entryStage, "scan")
  assert.match(item?.state.goal ?? "", /^Upgrade com\.fasterxml\.jackson\.core:jackson-databind to 2\.9\.10\.8/)
  assert.match(item?.state.goal ?? "", /Ecosystem: Maven/)
  assert.match(item?.state.goal ?? "", /mvn versions:use-dep-version/)
  assert.match(item?.state.goal ?? "", /Spring Boot BOM/)
  assert.ok(log.some((c) => c.includes(`runs/dep-sitter/.claims/${JACKSON_KEY}`)))
  // No npm manifest in this repo — the npm adapter must never have run.
  assert.ok(log.every((c) => !c.startsWith("npm ")))
})

test("a gradle repo with a lockfile claims via -L gradle.lockfile with the version-catalog work order", async () => {
  const log: string[] = []
  const report = osvReport([{ name: "ch.qos.logback:logback-classic", version: "1.2.3", severity: "CRITICAL", fixed: "1.2.9" }])
  const { item, skip } = await ecoSource({
    files: {
      "build.gradle.kts": `dependencies { implementation("ch.qos.logback:logback-classic:1.2.3") }`,
      "gradle.lockfile": "ch.qos.logback:logback-classic:1.2.3=runtimeClasspath",
    },
    script: [OSV_OK, { cmd: "osv-scanner --format json -L gradle.lockfile", result: { exitCode: 1, stdout: report } }],
    log,
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, LOGBACK_KEY)
  assert.match(item?.state.goal ?? "", /Ecosystem: Gradle/)
  assert.match(item?.state.goal ?? "", /--write-locks/)
})

test("a gradle repo without a lockfile is an actionable enable-locking skip, never a silent nothing", async () => {
  const { item, skip } = await ecoSource({
    files: { "build.gradle": "dependencies {}" },
    script: [OSV_OK],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /dependency locking/)
  assert.match(skip?.message ?? "", /--write-locks/)
  assert.equal(skip?.actionable, true)
})

test("a missing osv-scanner binary is an actionable skip on a JVM-only repo", async () => {
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM },
    script: [{ cmd: "osv-scanner --version", result: { exitCode: 127, stderr: "not found" } }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /osv-scanner not found — install it/)
  assert.equal(skip?.actionable, true)
})

test("npm keeps claiming when osv-scanner is missing in a mixed repo — the maven skip becomes a warning", async () => {
  const log: string[] = []
  const warnings: string[] = []
  const { item, skip } = await ecoSource({
    files: { "package.json": "{}", "pom.xml": POM },
    script: [
      { cmd: "osv-scanner --version", result: { exitCode: 127 } },
      { cmd: "npm audit --json", result: { exitCode: 1, stdout: audit({ lodash: vuln({}) }) } },
      { cmd: "npm ls --json", result: { stdout: installed({ lodash: "4.17.20" }) } },
    ],
    log,
    warnings,
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, LODASH)
  assert.ok(warnings.some((w) => w.includes("osv-scanner not found")))
})

test("vulnerable packages not declared in the pom are transitives — logged, never claimed", async () => {
  const warnings: string[] = []
  const transitive = osvReport([
    { name: "com.fasterxml.jackson.core:jackson-core", version: "2.9.10", severity: "CRITICAL", fixed: "2.9.10.8" },
  ])
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM }, // declares jackson-databind, NOT jackson-core
    script: [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: transitive } }],
    warnings,
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no auto-fixable upgrades/)
  assert.ok(warnings.some((w) => w.includes("jackson-core") && w.includes("transitive")))
})

test("a mixed monorepo merges ecosystems severity-first: a critical maven advisory outranks a high npm one", async () => {
  const critical = osvReport([
    { name: "org.springframework:spring-web", version: "5.3.30", severity: "CRITICAL", fixed: "5.3.39" },
  ])
  const { item } = await ecoSource({
    files: { "package.json": "{}", "pom.xml": POM.replace("jackson-databind", "spring-web") },
    script: [
      { cmd: "npm audit --json", result: { exitCode: 1, stdout: audit({ lodash: vuln({}) }) } }, // high
      { cmd: "npm ls --json", result: { stdout: installed({ lodash: "4.17.20" }) } },
      OSV_OK,
      { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: critical } },
    ],
  }).claimNext()
  assert.equal(item?.id, SPRING_KEY)
})

test("a maven ledger suppresses a handled target until it moves — the shared dedup, unchanged", async () => {
  const files = {
    "pom.xml": POM,
    [`docs/tasks/runs/dep-sitter/${JACKSON_KEY}.json`]: JSON.stringify({
      pkg: "com.fasterxml.jackson.core:jackson-databind",
      versionHandled: "2.9.10.8",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const script = [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: JACKSON } }]
  const suppressed = await ecoSource({ files, script }).claimNext()
  assert.equal(suppressed.item, null)
  assert.match(suppressed.skip?.message ?? "", /no auto-fixable upgrades/)
})

test("an explicit ecosystem override scopes the scan — npm commands never run", async () => {
  const log: string[] = []
  const { item } = await ecoSource({
    files: { "package.json": "{}", "pom.xml": POM },
    script: [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: JACKSON } }],
    log,
    ecosystem: "maven",
  }).claimNext()
  assert.equal(item?.id, JACKSON_KEY)
  assert.ok(log.every((c) => !c.startsWith("npm ")))
})

test("an explicitly configured maven ecosystem with no pom.xml is an actionable skip", async () => {
  const { item, skip } = await ecoSource({ files: { "package.json": "{}" }, ecosystem: "maven" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no pom\.xml was found/)
  assert.equal(skip?.actionable, true)
})

// --- a failed npm audit must never read as "no vulnerabilities" ---

test("empty npm audit stdout is an actionable skip, not a clean scan", async () => {
  // `AuditSchema` defaults `vulnerabilities` to {} and the old code coerced empty
  // stdout with `|| "{}"`, so a repo with no lockfile (or an unreachable registry,
  // or npm missing) parsed into a valid EMPTY audit — the dep-sitter reported
  // "no auto-fixable upgrades" forever while never actually scanning anything.
  const { item, skip } = await source({ auditJson: "" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /npm audit did not produce a report/)
  assert.equal(skip?.actionable, true)
})

test("an npm audit error body is an actionable skip, not a clean scan", async () => {
  const { item, skip } = await source({ auditJson: JSON.stringify({ error: { code: "EUSAGE", summary: "no lockfile" } }) }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /npm audit did not produce a report/)
  assert.equal(skip?.actionable, true)
})

test("a genuinely clean audit still reports no candidates, not a scan failure", async () => {
  const { item, skip } = await source({ auditJson: JSON.stringify({ vulnerabilities: {} }) }).claimNext()
  assert.equal(item, null)
  assert.doesNotMatch(skip?.message ?? "", /did not produce a report/)
  assert.match(skip?.message ?? "", /no auto-fixable upgrades/)
})

// --- workflows.<kind>.scannerCommand: a site's own JVM scanner ---

test("the scripted shell renders a {raw} splice, so scannerCommand tests see the real command", () => {
  const log: string[] = []
  const $ = scriptedShell([], log)
  void $`${{ raw: "corp-scan --json pom.xml" }}`
  assert.deepEqual(log, ["corp-scan --json pom.xml"])
})

test("renderScannerCommand substitutes the internal constants and reports typos", () => {
  assert.deepEqual(renderScannerCommand("corp-scan --json {{target}}", { target: "pom.xml", ecosystem: "maven" }), {
    command: "corp-scan --json pom.xml",
    unknown: [],
  })
  assert.deepEqual(
    renderScannerCommand("corp-scan {{ecosystem}} {{target}} --also {{target}}", { target: "g.lockfile", ecosystem: "gradle" }),
    { command: "corp-scan gradle g.lockfile --also g.lockfile", unknown: [] },
  )
  // A whole-repo scanner names no target and gets nothing appended.
  assert.deepEqual(renderScannerCommand("corp-scan --all", { target: "pom.xml", ecosystem: "maven" }), {
    command: "corp-scan --all",
    unknown: [],
  })
  // A typo stays literal AND is reported — never silently shipped to the shell.
  assert.deepEqual(renderScannerCommand("corp-scan {{targt}}", { target: "pom.xml", ecosystem: "maven" }), {
    command: "corp-scan {{targt}}",
    unknown: ["targt"],
  })
})

test("a configured scannerCommand replaces osv-scanner entirely, probe included", async () => {
  const log: string[] = []
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM },
    script: [{ cmd: "corp-scan --json pom.xml", result: { exitCode: 1, stdout: JACKSON_VULN_LIST } }],
    scannerCommand: "corp-scan --json {{target}}",
    log,
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, JACKSON_KEY)
  assert.match(item?.state.goal ?? "", /^Upgrade com\.fasterxml\.jackson\.core:jackson-databind to 2\.9\.10\.8/)
  assert.ok(log.includes("corp-scan --json pom.xml"))
  assert.ok(log.every((c) => !c.includes("osv-scanner")), "the --version probe must be skipped too")
})

test("{{ecosystem}} resolves on the gradle path", async () => {
  const log: string[] = []
  const report = vulnList([{ name: "ch.qos.logback:logback-classic", version: "1.2.3", severity: "CRITICAL", fixed: "1.2.9" }])
  const { item } = await ecoSource({
    files: {
      "build.gradle.kts": `dependencies { implementation("ch.qos.logback:logback-classic:1.2.3") }`,
      "gradle.lockfile": "ch.qos.logback:logback-classic:1.2.3=runtimeClasspath",
    },
    script: [{ cmd: "corp-scan gradle gradle.lockfile", result: { exitCode: 1, stdout: report } }],
    scannerCommand: "corp-scan {{ecosystem}} {{target}}",
    log,
  }).claimNext()
  assert.equal(item?.id, LOGBACK_KEY)
  assert.ok(log.includes("corp-scan gradle gradle.lockfile"))
})

test("a custom scanner's work order tells the stage NOT to re-run a scanner", async () => {
  const { item } = await ecoSource({
    files: { "pom.xml": POM },
    script: [{ cmd: "corp-scan", result: { exitCode: 1, stdout: JACKSON_VULN_LIST } }],
    scannerCommand: "corp-scan {{target}}",
  }).claimNext()
  const goal = item?.state.goal ?? ""
  assert.doesNotMatch(goal, /confirm the advisory with `osv-scanner/)
  assert.match(goal, /established fact/)
  assert.match(goal, /do NOT re-run a scanner/)
  // The rest of the Maven guidance is untouched.
  assert.match(goal, /mvn versions:use-dep-version/)
})

test("empty scanner output is an actionable skip on BOTH paths, never a confident zero", async () => {
  const custom = await ecoSource({
    files: { "pom.xml": POM },
    script: [{ cmd: "corp-scan pom.xml", result: { exitCode: 0, stdout: "", stderr: "corp-scan: not found" } }],
    scannerCommand: "corp-scan {{target}}",
  }).claimNext()
  assert.equal(custom.item, null)
  assert.match(custom.skip?.message ?? "", /produced no output/)
  assert.match(custom.skip?.message ?? "", /corp-scan pom\.xml/)
  assert.match(custom.skip?.message ?? "", /scannerCommand/)
  assert.doesNotMatch(custom.skip?.message ?? "", /no auto-fixable upgrades/)
  assert.equal(custom.skip?.actionable, true)

  // The default osv-scanner path had the same hole and is fixed with it.
  const dflt = await ecoSource({
    files: { "pom.xml": POM },
    script: [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 0, stdout: "" } }],
  }).claimNext()
  assert.equal(dflt.item, null)
  assert.match(dflt.skip?.message ?? "", /produced no output/)
  assert.doesNotMatch(dflt.skip?.message ?? "", /scannerCommand/, "no config advice when nothing was configured")
})

test("unreadable scanner output is an actionable skip naming the command", async () => {
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM },
    script: [{ cmd: "corp-scan pom.xml", result: { exitCode: 0, stdout: "<html>proxy error</html>" } }],
    scannerCommand: "corp-scan {{target}}",
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /could not read `corp-scan pom\.xml`/)
  assert.equal(skip?.actionable, true)
})

test("an unrecognized severity vocabulary is an error, not a silently empty scan", async () => {
  const { item, skip } = await ecoSource({
    files: { "pom.xml": POM },
    script: [
      {
        cmd: "corp-scan pom.xml",
        result: {
          exitCode: 1,
          stdout: vulnList([
            { name: "com.fasterxml.jackson.core:jackson-databind", version: "2.9.10", severity: "ELEVATED", fixed: "2.9.10.8" },
          ]),
        },
      },
    ],
    scannerCommand: "corp-scan {{target}}",
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /"ELEVATED"/)
  assert.match(skip?.message ?? "", /low\/moderate\/medium\/high\/critical/)
  assert.equal(skip?.actionable, true)
})

test("the default osv-scanner invocation stays byte-identical when no command is configured", async () => {
  const log: string[] = []
  await ecoSource({
    files: { "pom.xml": POM },
    script: [OSV_OK, { cmd: "osv-scanner --format json -L pom.xml", result: { exitCode: 1, stdout: JACKSON } }],
    log,
  }).claimNext()
  assert.deepEqual(
    log.filter((c) => c.startsWith("osv-scanner")),
    ["osv-scanner --version", "osv-scanner --format json -L pom.xml"],
  )
})

test("scannerCommand never touches the npm path in a mixed repo", async () => {
  const log: string[] = []
  const { item } = await ecoSource({
    files: { "package.json": "{}", "pom.xml": POM },
    script: [
      { cmd: "corp-scan pom.xml", result: { exitCode: 0, stdout: JSON.stringify({ vulns: [] }) } },
      { cmd: "npm audit --json", result: { exitCode: 1, stdout: audit({ lodash: vuln({}) }) } },
      { cmd: "npm ls --json", result: { stdout: installed({ lodash: "4.17.20" }) } },
    ],
    scannerCommand: "corp-scan {{target}}",
    log,
  }).claimNext()
  assert.equal(item?.id, LODASH)
  assert.ok(log.includes("npm audit --json"))
  assert.ok(log.includes("npm ls --json --depth=0"))
  // The npm goal carries no ecosystem guidance and is unchanged by the knob.
  assert.doesNotMatch(item?.state.goal ?? "", /Ecosystem:/)
  assert.doesNotMatch(item?.state.goal ?? "", /established fact/)
})

test("a gradle repo without a lockfile still hard-skips even with a custom scanner", async () => {
  const { item, skip } = await ecoSource({
    files: { "build.gradle": "dependencies {}" },
    script: [{ cmd: "corp-scan", result: { exitCode: 0, stdout: JSON.stringify({ vulns: [] }) } }],
    scannerCommand: "corp-scan {{target}}",
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /dependency locking/)
})
