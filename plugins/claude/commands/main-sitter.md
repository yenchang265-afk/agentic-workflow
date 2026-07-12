---
description: The main sitter loop — claim red CI on the default branch and drive it through diagnose → remedy → verify → publish
argument-hint: claim | status | stop
---

You are about to work the **main sitter agentic loop** (typed as
`/agentic-loop:main-sitter`) — it sits on the watched branch's CI: when the
newest head goes red it diagnoses (bisecting when needed) and publishes a
verified draft fix or revert PR. Read the `loop-orchestration` skill now;
then act on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`claim`** — call `mcp__agentic-loop__loop_claim({kind: "main-sitter"})`
  to judge the watched branch's newest head and, when it is red and
  unhandled, drive it per the main-sitter manifest: `loop_stage` before
  spawning each stage subagent (`loop-main-diagnose` / `loop-main-remedy` /
  `loop-verify` / `loop-main-publish` — diagnose → remedy → verify → publish
  — via the Task tool) and `loop_advance` after each returns, until a
  terminal action. A green or in-flight head claims nothing; a handled head
  waits for the next push.
- **`status`** (or bare) — call `mcp__agentic-loop__loop_status` and report
  the active loop state.
- **`stop`** (alias: `abort`) — call `mcp__agentic-loop__loop_stop` to abort
  the active loop.
- **anything else** — do not run it. Show this usage instead.

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
