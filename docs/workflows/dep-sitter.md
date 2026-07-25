English | [繁體中文](dep-sitter.zh-TW.md)

# dep-sitter

Sits on vulnerable and outdated dependencies: confirms the advisory, applies the patch/minor upgrade on a branch, fixes the fallout, verifies the suite is green, and opens a draft PR. **Major bumps are never auto-fixed and merging stays a human call.**

SCAN → UPGRADE → VERIFY → PUBLISH (up to 2 iterations)

## Enable

Add to `.agentic-workflow.json`:

```jsonc
{
  "workflows": {
    "dep-sitter": {
      "enabled": true,
      "severityFloor": "high"
    }
  }
}
```

The `severityFloor` filters which advisories trigger fixes (e.g., `high`, `critical`). See [`docs/sitters.md`](../sitters.md) for all config options.

## Commands

**OpenCode**

```
/agentic-workflow:dep-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-workflow:dep-sitter claim | status | stop
```

(Claude Code has no standing watcher; call `claim` again to pull the next dependency.)

## Architecture

Sits on vulnerable or outdated dependencies across three ecosystems: **npm**
(native `npm audit`/`npm outdated`), and **Maven**/**Gradle** via
[OSV-Scanner](https://google.github.io/osv-scanner/) querying the OSV.dev
database (the `osv-scanner` binary must be installed on the watcher host for
the JVM ecosystems — missing it is an actionable skip, npm keeps working
without it; Gradle additionally needs a committed `gradle.lockfile` or
`gradle/verification-metadata.xml` since osv-scanner can't parse
`build.gradle` itself). **scan** (check) → **upgrade** (worktree, on a
`dep-sitter/*` branch: bump the manifest, refresh the lockfile, fix the
fallout) → **verify** (runs the suite) → **publish** opens a **draft PR**.
**Major bumps are never auto-fixed** — logged and left for a human, and
merging always stays a human call. Vulnerable JVM transitives (not declared
in the build files) are logged, never claimed — pinning one is a human call,
mirroring npm's direct-only rule.

- **`workflows.dep-sitter.enabled`** — default off.
- **`workflows.dep-sitter.ecosystem`** — `auto` (default: detect every ecosystem
  the repo declares and merge candidates severity-first) | `npm` | `maven` |
  `gradle`.
- **`workflows.dep-sitter.severityFloor`** — minimum claimable advisory
  severity: `low` | `moderate` | `high` (default) | `critical`.
- **`workflows.dep-sitter.includeOutdated`** — default `false`; also claim
  non-vulnerable but outdated direct dependencies within the patch/minor
  policy. **npm only** — ignored (with a log line) for maven/gradle.
- **`workflows.dep-sitter.scannerCommand`** — replace the bundled
  `osv-scanner --format json -L <target>` call with your own CLI. See below.

## Using your own scanner (`scannerCommand`)

Sites that run a corporate dependency scanner can substitute it for
`osv-scanner` on the **JVM ecosystems only** — the npm path keeps using
`npm audit --json` regardless.

```jsonc
// ~/.config/agentic-workflow/agentic-workflow.json  — USER scope, see below
{
  "workflows": {
    "dep-sitter": {
      "enabled": true,
      "scannerCommand": "corp-scan --format osv --json {{target}}"
    }
  }
}
```

`{{target}}` is the lockfile path (`pom.xml`, `gradle.lockfile`, or
`gradle/verification-metadata.xml`) and `{{ecosystem}}` is `maven`/`gradle`. A
command naming neither runs verbatim — a scanner that scans the whole repo is
fine. When a custom command is set the `osv-scanner --version` probe is skipped
entirely.

> **User scope only.** `scannerCommand` is shell the loop executes verbatim, so
> it is honored from your user-scope config only. A repo's
> `.agentic-workflow.json` setting it is dropped with a warning — otherwise
> cloning a repo would be enough to run arbitrary shell on first claim. Same
> rule as `worktreeSetup`.

### The payload contract

Stdout must be either an osv-scanner report (`{"results":[…]}`) or a list of raw
OSV vulnerability records. Both are accepted with no `format` knob:

```jsonc
{ "vulns":           [ /* records */ ] }   // preferred
{ "vulnerabilities": [ /* records */ ] }
{ "findings":        [ /* records */ ] }
[ /* records */ ]                          // bare array
```

A minimal valid record:

```json
{
  "vulns": [
    {
      "id": "CVE-2024-12345",
      "severity": "HIGH",
      "affected": [
        {
          "package": {
            "name": "com.fasterxml.jackson.core:jackson-databind",
            "ecosystem": "Maven",
            "version": "2.13.4"
          },
          "ranges": [
            { "type": "ECOSYSTEM",
              "events": [{ "introduced": "0" }, { "fixed": "2.13.4.2" }] }
          ]
        }
      ]
    }
  ]
}
```

Only five things are required per record:

| Field | Why |
|---|---|
| `id` | Dedup key — a missing or duplicate id collapses distinct advisories into one |
| `severity` | The rating. `low`/`moderate`/`medium`/`high`/`critical`, case-insensitive |
| `affected[].package.name` | **`group:artifact` on the JVM** — see below |
| `affected[].package.version` | The *installed* version |
| `affected[].ranges[].events[].fixed` | The upgrade target; absent ⇒ reported as unfixable, never claimed |

Everything else (`aliases`, `summary`, `references`, `ranges[].type`, unknown
keys anywhere) is ignored and never fails the parse.

**Package naming is the easiest thing to get wrong.** `name` must be the full
`group:artifact`. Maven declaration is checked by splitting on `:` and looking
for `<artifactId>…</artifactId>` in `pom.xml`; Gradle looks for the whole
`group:artifact` string in `build.gradle(.kts)` or `gradle/libs.versions.toml`.
A package matched by neither is classed a transitive — reported, never claimed.
If claims come back empty with everything landing in transitives, check this
first.

**Installed version** is probed in order: `affected[].package.version` →
`database_specific.installed` → `.installedVersion` → `.current_version` →
`versions[0]`. Prefer the first. `versions[0]` is last and logged as
low-confidence because in standard OSV that array lists every *affected*
version, so element 0 is the oldest affected release, not what is installed —
and a wrong current version can let a major bump read as minor.

**Severity vocabulary** outside the five accepted terms maps to unknown, which
ranks below every floor. Rather than silently dropping the package, an
unrecognized label is logged with the raw value quoted, and a payload whose
every record is unreadable is an actionable skip naming what it saw. Extend
`normalizeLabel` in `packages/core/src/source/osv.ts` to add a site's own terms.

Empty stdout is always an actionable skip, never "no vulnerabilities".

### Limitation: stage agents cannot re-run your scanner

The custom command runs **driver-side**, in the work source, before any agent
starts. Stage agents cannot invoke it: the SCAN stage's bash allowlist is fixed
in the manifest, and on the OpenCode host the agent's permission map is
generated at build time and cannot be parameterized by config at all.

This costs nothing in practice — the work source already pinned the package,
current version and target before the item existed, so SCAN confirms what it
can (still declared? target exists? bump within impact?) and the work order
tells it not to hunt for a scanner. If you do need the binary on the stage
allowlist, copy the manifest into your own workflows directory
(`AGENTIC_WORKFLOW_WORKFLOWS_DIR`) and add the glob there.

## Example: One-shot scan and upgrade

Manually check for vulnerable dependencies and fix one:

1. **Claim one dependency**
   ```
   /agentic-workflow:dep-sitter claim
   ```
   Polls dependency reports (npm `audit`/`outdated`, Maven/Gradle via OSV-Scanner) for the next fixable advisory. Runs SCAN (confirm the advisory), UPGRADE (apply the patch/minor bump), VERIFY (run the test suite), then PUBLISH (open a draft PR with the bumped lockfile). You review and merge by hand.

2. **Check status**
   ```
   /agentic-workflow:dep-sitter status
   ```
   Shows which dependency is being upgraded, or "idle" if none are pending.

## Example: Weekly scheduled scan

Set up a cron job to scan and fix dependencies every Monday at 9 AM:

1. **Start the cron-triggered watcher**
   ```
   /agentic-workflow:dep-sitter watch cron "0 9 * * 1"
   ```
   (OpenCode only.) `watch` turns this session into the worker; it fires on the cron schedule and claims one dependency each time. Useful for regular security hygiene.

2. **Stop the watcher**
   ```
   /agentic-workflow:dep-sitter stop
   ```
   Run from a separate session/terminal (the watching session is occupied), or press ESC/`unwatch` first.

## Learn more

- What all four sitters share, and the threat model: [`docs/sitters.md`](../sitters.md), [`docs/design/threat-model.md`](../design/threat-model.md)
- Command reference: [`docs/opencode.md`](../opencode.md) (OpenCode), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Framework internals: [`docs/architecture.md`](../architecture.md)
