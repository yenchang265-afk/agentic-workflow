---
name: agentic-loop:main-sitter
description: The main sitter loop — watch or claim red CI on the default branch and drive it through diagnose → remedy → verify → publish
argument-hint: claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
---

The main sitter agentic loop — sits on the watched branch's CI (`gh run
list`): when the newest head goes red it diagnoses (bisecting when needed)
and publishes a verified draft fix or revert PR. The plugin intercepts this
command; `$ARGUMENTS` selects the verb. Every verb is deterministic plugin
work: **invoke nothing, write nothing** — report the toast's outcome and
stop.

**$ARGUMENTS**

Dispatch:

- **`claim`** — one-shot pull: judge the watched branch's newest head and,
  when it is red and unhandled, drive it once this turn settles
  (DIAGNOSE → REMEDY → VERIFY → PUBLISH per the main-sitter manifest,
  `packages/core/loops/main-sitter/`). A green or in-flight head claims
  nothing; a handled head waits for the next push.
- **`watch [trigger]`** — put **this** session into main-sitter worker mode.
  Bare `watch` uses the kind's configured trigger
  (`loops.main-sitter.trigger`, default poll); an argument overrides it for
  this session only: `poll [interval]` / a bare interval, `cron <schedule>`,
  or `idle`. One watcher process per clone.
- **`unwatch`** — leave watch mode; a drive already in flight still finishes.
- **`stop`** (alias: `abort`) — abort the active loop and exit watch mode in
  this session.
- **`status`** — print the current loop (stage, iteration, watch state and
  cadence). Bare `/agentic-loop:main-sitter` (no arguments) does the same.

The kind must be enabled in `.agentic-loop.json`:

```json
{ "loops": { "main-sitter": { "enabled": true, "branch": "main" } } }
```

`branch` overrides the watched branch (default: the remote default branch);
the manifest's `workflows` list narrows which workflows are judged.
GitHub-only for now (`gh run list` / `gh pr create`); on an `ado` platform
the kind is skipped with a warning. The watched branch is NEVER pushed — the
remedy lands as a DRAFT PR on a `main-sitter/*` branch (enforced by the
branch-scoped push allowlist), and merging stays a human call.

Task authoring and the engineering backlog live in the sibling command:
`/agentic-loop:engineering`.
