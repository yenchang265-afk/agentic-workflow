---
name: agentic-workflow:dep-sitter
description: The dep sitter loop — watch or claim vulnerable/outdated dependencies and drive them through scan → upgrade → verify → publish
argument-hint: claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
---

The dep sitter agentic loop — sits on vulnerable and outdated dependencies
(npm via `npm audit`/`npm outdated`; Maven/Gradle via OSV-Scanner over
`pom.xml`/`gradle.lockfile`) and turns each auto-fixable one into a
verified draft PR. The plugin intercepts this command; `$ARGUMENTS` selects
the verb. Every verb is deterministic plugin work: **invoke nothing, write
nothing** — report the toast's outcome and stop.

**$ARGUMENTS**

Dispatch:

- **`claim`** — one-shot pull: poll the dependency reports for the next
  claimable upgrade and drive it once this turn settles
  (SCAN → UPGRADE → VERIFY → PUBLISH per the dep-sitter manifest,
  `packages/core/workflows/dep-sitter/`). Major bumps are never claimed — they
  are logged and left for a human.
- **`watch [trigger]`** — put **this** session into dep-sitter worker mode.
  Bare `watch` uses the kind's configured trigger
  (`workflows.dep-sitter.trigger`, default poll); an argument overrides it for
  this session only: `poll [interval]` / a bare interval, `cron <schedule>`,
  or `idle`. One watcher process per clone.
- **`unwatch`** — leave watch mode; a drive already in flight still finishes.
- **`stop`** (alias: `abort`) — abort the active loop and exit watch mode in
  this session.
- **`status`** — print the current loop (stage, iteration, watch state and
  cadence). Bare `/agentic-workflow:dep-sitter` (no arguments) does the same.

The kind must be enabled in `.agentic-workflow.json`:

```json
{ "workflows": { "dep-sitter": { "enabled": true, "severityFloor": "high" } } }
```

`severityFloor` (low|moderate|high|critical), `includeOutdated` (npm only:
also claim non-vulnerable stale deps), and `ecosystem` (auto|npm|maven|gradle;
auto detects and merges — JVM ecosystems need the `osv-scanner` binary, and
Gradle a committed lockfile) override the manifest policy. GitHub-only
for now (`gh pr create`); on an `ado` platform the kind is skipped with a
warning. Every upgrade lands as a DRAFT pull request on a `feature/*` branch
— the sitter never merges and never pushes the default branch (enforced by
the branch-scoped push allowlist).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-workflow:engineering`.
