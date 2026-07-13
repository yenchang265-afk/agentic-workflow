import { defaultLoopsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { detectEcosystems, makeDependencyScanSource, semverImpact, upgradeCandidates } from "./dependency-scan.js"

/**
 * The dependency-scan source over the real dep-sitter manifest, against a
 * scripted npm shell. The candidate policy (floor, majors, outdated merge) is
 * covered on the pure `upgradeCandidates`; the source tests cover polling,
 * ledger dedup, claim mechanics, and terminal ledger writes.
 */

const LOOPS_DIR = defaultLoopsDir()
const sitter = loadManifest(LOOPS_DIR, "dep-sitter")

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

/** Scripted shell: first matching prefix wins; unmatched commands succeed empty. */
const scriptedShell = (script: Cmd[], log: string[] = []): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
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
  assert.equal(item?.id, "dep-lodash")
  assert.equal(item?.entryStage, "scan")
  assert.equal(item?.state.kind, "dep-sitter")
  assert.equal(item?.state.git, undefined)
  assert.match(item?.state.goal ?? "", /^Upgrade lodash to 4\.17\.21/)
  assert.match(item?.state.goal ?? "", /DRAFT pull request/)
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.includes("runs/dep-sitter/.claims/dep-lodash")))
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
    "docs/tasks/runs/dep-sitter/dep-lodash.json": JSON.stringify({
      pkg: "lodash",
      versionHandled: "4.17.21",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: handled }).claimNext()).item, null)
  const failed = {
    "docs/tasks/runs/dep-sitter/dep-lodash.json": JSON.stringify({
      pkg: "lodash",
      failedAttempts: [{ target: "4.17.21", at: "2026-07-04T00:00:00Z" }],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: failed }).claimNext()).item, null)
  // A newer fix version is a fresh claim.
  const newer = audit({ lodash: vuln({ fixAvailable: { name: "lodash", version: "4.17.22", isSemVerMajor: false } }) })
  assert.equal((await source({ ledgers: handled, auditJson: newer }).claimNext()).item?.id, "dep-lodash")
})

test("onTerminal(done) records the published target; stop records a failed attempt", async () => {
  const log: string[] = []
  const src = source({ log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "draft PR opened" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("dep-lodash.json"))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /versionHandled/)
  assert.match(write ?? "", /4\.17\.21/)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("dep-lodash")))
})

test("onTerminal: a genuine stop records a failed attempt; a retryable (onError) stop does not (C2)", async () => {
  const genuine: string[] = []
  const g = source({ log: genuine })
  const c1 = await g.claimNext()
  assert.ok(c1.item)
  await g.onTerminal?.(c1.item, { kind: "stop", message: "capped" })
  const gWrite = genuine.find((c) => c.startsWith("printf") && c.includes("dep-lodash.json"))
  assert.match(gWrite ?? "", /failedAttempts/, "genuine stop records a failed attempt")

  const transient: string[] = []
  const t = source({ log: transient })
  const c2 = await t.claimNext()
  assert.ok(c2.item)
  await t.onTerminal?.(c2.item, { kind: "stop", message: "osv-scanner unavailable", retryable: true })
  assert.ok(
    !transient.some((c) => c.startsWith("printf") && c.includes("dep-lodash.json")),
    "retryable stop leaves the ledger untouched so the next poll re-claims",
  )
  assert.ok(transient.some((c) => c.startsWith("rmdir") && c.includes("dep-lodash")), "claim marker still released")
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
} = {}) =>
  makeDependencyScanSource({
    $: scriptedShell(opts.script ?? [], opts.log),
    client: ledgerClient(opts.files ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void opts.warnings?.push(m),
    loaded: sitter,
    ...(opts.ecosystem ? { ecosystem: opts.ecosystem } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

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
  assert.equal(item?.id, "dep-com-fasterxml-jackson-core-jackson-databind")
  assert.equal(item?.entryStage, "scan")
  assert.match(item?.state.goal ?? "", /^Upgrade com\.fasterxml\.jackson\.core:jackson-databind to 2\.9\.10\.8/)
  assert.match(item?.state.goal ?? "", /Ecosystem: Maven/)
  assert.match(item?.state.goal ?? "", /mvn versions:use-dep-version/)
  assert.match(item?.state.goal ?? "", /Spring Boot BOM/)
  assert.ok(log.some((c) => c.includes("runs/dep-sitter/.claims/dep-com-fasterxml-jackson-core-jackson-databind")))
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
  assert.equal(item?.id, "dep-ch-qos-logback-logback-classic")
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
  assert.equal(item?.id, "dep-lodash")
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
  assert.equal(item?.id, "dep-org-springframework-spring-web")
})

test("a maven ledger suppresses a handled target until it moves — the shared dedup, unchanged", async () => {
  const files = {
    "pom.xml": POM,
    "docs/tasks/runs/dep-sitter/dep-com-fasterxml-jackson-core-jackson-databind.json": JSON.stringify({
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
  assert.equal(item?.id, "dep-com-fasterxml-jackson-core-jackson-databind")
  assert.ok(log.every((c) => !c.startsWith("npm ")))
})

test("an explicitly configured maven ecosystem with no pom.xml is an actionable skip", async () => {
  const { item, skip } = await ecoSource({ files: { "package.json": "{}" }, ecosystem: "maven" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no pom\.xml was found/)
  assert.equal(skip?.actionable, true)
})
