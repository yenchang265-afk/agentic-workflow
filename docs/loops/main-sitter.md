English | [繁體中文](main-sitter.zh-TW.md)

# main-sitter

Sits on the default branch's CI: when it goes red, diagnoses the failure on that exact head (bisecting when needed), writes a verified forward fix or revert, and opens a draft remedy PR — commenting once on the culprit PR. **Never pushes the watched branch; merging stays a human call.**

DIAGNOSE → REMEDY → VERIFY → PUBLISH (up to 2 iterations)

## Enable

Add to `.agentic-loop.json`:

```jsonc
{
  "loops": {
    "main-sitter": {
      "enabled": true,
      "branch": "main"
    }
  }
}
```

The `branch` defaults to the remote default branch. See [`docs/sitters.md`](../sitters.md) for all config options.

## Commands

**OpenCode**

```
/agentic-loop:main-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:main-sitter claim | status | stop
```

(Claude Code has no standing watcher; call `claim` again to poll for red CI.)

## Architecture

Sits on the watched branch's CI (`gh run list`, or the Azure Pipelines Build
API on ADO): when the newest completed head goes red it **diagnoses**
(worktree pinned to the red head, bisecting when needed) → **remedy**
(worktree; the smallest forward fix, or a `git revert`) → **verify** →
**publish** opens a **draft remedy PR** on a `main-sitter/*` branch and
comments once on the culprit PR. It **never pushes the watched branch
itself**; merging always stays a human call.

- **`loops.main-sitter.enabled`** — default off.
- **`loops.main-sitter.branch`** — overrides the watched branch; unset ⇒ the
  remote default branch (from `origin/HEAD`, falling back to `main`).

## Example: One-shot CI repair

Manually check for a red CI run on main and fix it:

1. **Claim the red CI head**
   ```
   /agentic-loop:main-sitter claim
   ```
   Polls the watched branch's CI (GitHub Actions or Azure Pipelines) for the newest failing run. If found, runs DIAGNOSE (checkout that exact head, bisect if needed to find the culprit commit), REMEDY (write a forward fix or revert on a worktree branch), VERIFY (run the suite again), then PUBLISH (open a draft fix or revert PR, comment on the culprit PR). You review and merge by hand.

2. **Check status**
   ```
   /agentic-loop:main-sitter status
   ```
   Shows which CI head is being diagnosed, or "idle" if main is green.

## Example: Continuous watching with 10-minute polling

Set up a standing watcher to catch and fix red CI quickly:

1. **Start the watcher**
   ```
   /agentic-loop:main-sitter watch 10m
   ```
   (OpenCode only.) `watch` turns this session into the worker; it polls every 10 minutes and claims one red CI head each time, fixing it unattended. Useful for high-priority repos where you want CI green ASAP.

2. **Stop the watcher**
   ```
   /agentic-loop:main-sitter stop
   ```
   Run from a separate session/terminal (the watching session is occupied), or press ESC/`unwatch` first.

## Learn more

- What all four sitters share, and the threat model: [`docs/sitters.md`](../sitters.md), [`docs/design/threat-model.md`](../design/threat-model.md)
- Command reference: [`docs/opencode.md`](../opencode.md) (OpenCode), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Framework internals: [`docs/architecture.md`](../architecture.md)
