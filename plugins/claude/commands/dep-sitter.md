---
description: The dep sitter loop — claim vulnerable/outdated dependencies and drive them through scan → upgrade → verify → publish
argument-hint: claim | status | stop
---

You are about to work the **dep sitter agentic loop** (typed as
`/agentic-loop:dep-sitter`) — it sits on vulnerable and outdated
dependencies (`npm audit` / `npm outdated`) and turns each auto-fixable one
into a verified draft PR. Read the `loop-orchestration` skill now; then act
on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`claim`** — call `mcp__agentic-loop__loop_claim({kind: "dep-sitter"})`
  to poll the dependency reports for the next claimable upgrade and drive it
  per the dep-sitter manifest: `loop_stage` before spawning each stage
  subagent (`loop-dep-scan` / `loop-dep-upgrade` / `loop-verify` /
  `loop-dep-publish` — scan → upgrade → verify → publish — via the Task
  tool) and `loop_advance` after each returns, until a terminal action.
  Major bumps are never claimed — they are logged and left for a human.
- **`status`** (or bare) — call `mcp__agentic-loop__loop_status` and report
  the active loop state.
- **`stop`** (alias: `abort`) — call `mcp__agentic-loop__loop_stop` to abort
  the active loop.
- **anything else** — do not run it. Show this usage instead.

The kind must be enabled in `.agentic-loop.json`:

```json
{ "loops": { "dep-sitter": { "enabled": true, "severityFloor": "high" } } }
```

`severityFloor` (low|moderate|high|critical) and `includeOutdated` override
the manifest policy. GitHub-only for now (`gh pr create`); on an `ado`
platform the kind is skipped with a warning. Every upgrade lands as a DRAFT
pull request on a `feature/*` branch — the sitter never merges and never
pushes the default branch (enforced by the branch-scoped push allowlist).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-loop:engineering`.
