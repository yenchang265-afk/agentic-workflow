---
name: agentic-loop:pr-sitter
description: The PR sitter loop — watch or claim open pull requests and drive them through triage → fix → verify → publish
argument-hint: claim | watch [interval] | unwatch | stop | status
---

The PR sitter agentic loop — sits on your open pull requests (GitHub via
`gh`, or Azure DevOps via its REST API) and works actionable signals: failing
checks, unanswered review threads, merge conflicts. The plugin intercepts
this command; `$ARGUMENTS` selects the verb. Every verb is deterministic
plugin work: **invoke nothing, write nothing** — report the toast's outcome
and stop.

**$ARGUMENTS**

Dispatch:

- **`claim`** — one-shot pull: poll the configured PR source for the next
  actionable pull request and drive it once this turn settles
  (TRIAGE → FIX → VERIFY → PUBLISH per the pr-sitter manifest,
  `packages/core/loops/pr-sitter/`). A PR with nothing actionable is skipped.
- **`watch [interval]`** — put **this** session into PR-sitter worker mode:
  poll for actionable PRs on every idle tick plus a timer at `interval` —
  `30s`, `5m`, `2h`, or a bare number of minutes (default: the
  `watchIntervalMinutes` config, 5m; floor: 10s). One watcher process per
  clone (on-disk lease, stale leases taken over automatically).
- **`unwatch`** — leave watch mode; a drive already in flight still finishes.
- **`stop`** (alias: `abort`) — abort the active loop and exit watch mode in
  this session.
- **`status`** — print the current loop (stage, iteration, watch state and
  cadence). Bare `/agentic-loop:pr-sitter` (no arguments) does the same.

The kind must be enabled in `.agentic-loop.json`:

```json
{ "loops": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
```

`query` (GitHub) narrows which PRs are polled; on Azure DevOps set
`codePlatform: "ado"` plus the `ado` section instead. The sitter never
merges, completes, abandons, or approves a PR — it fixes, verifies, and
replies to threads; merging stays a human call (enforced by the stage
allowlists and the ADO write backstop).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-loop:engineering`.
