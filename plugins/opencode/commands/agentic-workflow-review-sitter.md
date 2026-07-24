---
name: agentic-workflow:review-sitter
description: The review sitter loop — watch or claim PRs whose review is requested from you and drive them through fetch → assess → publish
argument-hint: claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
---

The review sitter agentic loop — sits on pull requests where **your review is
requested** (GitHub via `gh`, or Azure DevOps via its REST API) and posts one
structured review comment per requested head. The plugin intercepts this
command; `$ARGUMENTS` selects the verb. Every verb is deterministic plugin
work: **invoke nothing, write nothing** — report the toast's outcome and stop.

**$ARGUMENTS**

Dispatch:

- **`claim`** — one-shot pull: poll for the next PR whose review is wanted
  and drive it once this turn settles (FETCH → ASSESS → PUBLISH per the
  review-sitter manifest, `packages/core/workflows/review-sitter/`). A PR whose
  head was already reviewed is skipped until a human pushes a new head.
- **`watch [trigger]`** — put **this** session into review-sitter worker
  mode. Bare `watch` uses the kind's configured trigger
  (`workflows.review-sitter.trigger`, default poll); an argument overrides it for
  this session only: `poll [interval]` / a bare interval (`30s`, `5m`, `2h`,
  or a bare number of minutes; floor: 10s), `cron <schedule>`, or `idle`.
  One watcher process per clone.
- **`unwatch`** — leave watch mode; a drive already in flight still finishes.
- **`stop`** (alias: `abort`) — abort the active loop and exit watch mode in
  this session.
- **`status`** — print the current loop (stage, iteration, watch state and
  cadence). Bare `/agentic-workflow:review-sitter` (no arguments) does the same.

This kind is **always on** — it needs no configuration and has no off
switch (`"enabled": false` on it is a config error). Narrow which PRs it
watches with:

```json
{ "workflows": { "review-sitter": { "query": "is:open review-requested:@me" } } }
```

`query` (GitHub) narrows which PRs are polled; on Azure DevOps set
`codePlatform: "ado"` plus the `ado` section instead — there the sitter
claims active PRs where `ado.selfLogin`'s reviewer vote is still pending.
The sitter holds **comment-only** authority: it never approves, requests
changes, votes, pushes, or merges — the human reviewer stays the reviewer of
record (enforced by the stage allowlists and the ADO write backstop).

Task authoring and the engineering backlog live in the sibling command:
`/agentic-workflow:engineering`.
