---
description: The PR sitter loop — claim open pull requests and drive them through triage → fix → verify → publish
argument-hint: claim | status | stop
---

You are about to work the **PR sitter agentic loop** (typed as
`/agentic-workflow:pr-sitter`) — it sits on your open pull requests (GitHub via
`gh`, or Azure DevOps via its REST API) and works actionable signals: failing
checks, unanswered review threads, merge conflicts. Read the
`workflow-orchestration` skill now (its "Workflow kinds" section covers the
pr-sitter manifest); then act on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`claim`** — call `mcp__agentic-workflow__workflow_claim({kind: "pr-sitter"})` to
  poll the configured PR source for the next actionable pull request and
  drive it per the pr-sitter manifest: `workflow_stage` before spawning each
  stage subagent (`workflow-pr-triage` / `workflow-pr-fix` / `workflow-verify` /
  `workflow-pr-publish` — triage → fix → verify → publish — via the Task tool,
  passing the response's `model` as the Task tool's `model` when present)
  and `workflow_advance` after each returns, until a terminal action. A PR with nothing actionable is skipped
  (triage FAIL → done). There is no standing watch mode on this substrate —
  `claim` is the pull; the OpenCode plugin's `/agentic-workflow:pr-sitter watch`
  is the push equivalent.
- **`status`** (or bare) — call `mcp__agentic-workflow__workflow_status` and report
  the active loop state.
- **`stop`** (alias: `abort`) — call `mcp__agentic-workflow__workflow_stop` to abort
  the active loop.
- **anything else** — do not run it. Show this usage instead.

The kind must be enabled in `.agentic-workflow.json`:

```json
{ "workflows": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
```

`query` (GitHub) narrows which PRs are polled; on Azure DevOps set
`codePlatform: "ado"` plus the `ado` section instead. The sitter never
merges, completes, abandons, or approves a PR — it fixes, verifies, and
replies to threads; merging stays a human call (enforced by the check-stage
allowlists and the ADO write backstop hook).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-workflow:engineering`.
