---
description: The review sitter loop — claim PRs whose review is requested from you and drive them through fetch → assess → publish
argument-hint: claim [<pr>] | status | stop
---

You are about to work the **review sitter agentic loop** (typed as
`/agentic-workflow:review-sitter`) — it sits on pull requests where **your review
is requested** (GitHub via `gh`, or Azure DevOps via the Azure DevOps MCP server) and posts
one structured review comment per requested head. Read the
`workflow-orchestration` skill now; then act on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`claim [<pr>]`** — call `mcp__agentic-workflow__workflow_claim({kind: "review-sitter"})`
  to poll for the next PR whose review is wanted and drive it per the
  review-sitter manifest: `workflow_stage` before spawning each stage subagent
  (`workflow-review-fetch` / `workflow-review-assess` / `workflow-review-publish` —
  fetch → assess → publish — via the Task tool, whose `model` a `PreToolUse`
  hook already binds from the response) and `workflow_advance` after
  each returns, until a terminal action. A head already reviewed is skipped until
  a human pushes a new one. To **force** a fresh review pass on a specific PR,
  pass its number as `target` — `workflow_claim({kind: "review-sitter", target: 42})` —
  and it is driven even if its head was already reviewed (fork PRs are still
  refused). There is no standing watch mode on this substrate
  — `claim` is the pull; the OpenCode plugin's
  `/agentic-workflow:review-sitter watch` is the push equivalent.
- **`status`** (or bare) — call `mcp__agentic-workflow__workflow_status` and report
  the active loop state.
- **`stop`** (alias: `abort`) — call `mcp__agentic-workflow__workflow_stop` to abort
  the active loop.
- **anything else** — do not run it. Show this usage instead.

This kind is **experimental and opt-in** — it does nothing until enabled,
and its config keys may still change:

```json
{ "workflows": { "review-sitter": { "enabled": true, "query": "is:open review-requested:@me" } } }
```

`query` (GitHub) narrows which PRs are polled; on Azure DevOps set
`codePlatform: "ado"` plus the `ado` section — there the sitter claims
active PRs where `ado.selfLogin`'s reviewer vote is still pending. The
sitter holds **comment-only** authority: it never approves, requests
changes, votes, pushes, or merges — the human reviewer stays the reviewer
of record (enforced by the stage allowlists and the ADO write backstop
hook).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-workflow:engineering`.
