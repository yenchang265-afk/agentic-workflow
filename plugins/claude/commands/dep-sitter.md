---
description: The dep sitter loop — claim vulnerable/outdated dependencies and drive them through scan → upgrade → verify → publish
argument-hint: claim | status | stop
---

You are about to work the **dep sitter agentic loop** (typed as
`/agentic-workflow:dep-sitter`) — it sits on vulnerable and outdated
dependencies (npm via `npm audit`/`npm outdated`; Maven/Gradle via
OSV-Scanner over `pom.xml`/`gradle.lockfile`) and turns each auto-fixable one
into a verified draft PR. Read the `workflow-orchestration` skill now; then act
on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`claim`** — call `mcp__agentic-workflow__workflow_claim({kind: "dep-sitter"})`
  to poll the dependency reports for the next claimable upgrade and drive it
  per the dep-sitter manifest: `workflow_stage` before spawning each stage
  subagent (`workflow-dep-scan` / `workflow-dep-upgrade` / `workflow-verify` /
  `workflow-dep-publish` — scan → upgrade → verify → publish — via the Task
  tool, passing the response's `model` as the Task tool's `model` when
  present) and `workflow_advance` after each returns, until a terminal action.
  Major bumps are never claimed — they are logged and left for a human.
- **`status`** (or bare) — call `mcp__agentic-workflow__workflow_status` and report
  the active loop state.
- **`stop`** (alias: `abort`) — call `mcp__agentic-workflow__workflow_stop` to abort
  the active loop.
- **anything else** — do not run it. Show this usage instead.

The kind must be enabled in `.agentic-workflow.json`:

```json
{ "workflows": { "dep-sitter": { "enabled": true, "severityFloor": "high" } } }
```

`severityFloor` (low|moderate|high|critical), `includeOutdated` (npm only),
and `ecosystem` (auto|npm|maven|gradle; JVM ecosystems need the `osv-scanner`
binary, Gradle a committed lockfile) override the manifest policy. GitHub-only for now (`gh pr create`); on an `ado`
platform the kind is skipped with a warning. Every upgrade lands as a DRAFT
pull request on a `feature/*` branch — the sitter never merges and never
pushes the default branch (enforced by the branch-scoped push allowlist).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-workflow:engineering`.
