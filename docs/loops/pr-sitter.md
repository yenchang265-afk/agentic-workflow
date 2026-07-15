# pr-sitter

Sits on open pull requests: answers review comments, fixes failing checks, resolves conflicts, and keeps the branch green until a human merges. **Never merges.**

TRIAGE → FIX → VERIFY → PUBLISH (up to 3 iterations)

## Enable

Add to `.agentic-loop.json`:

```jsonc
{
  "loops": {
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    }
  }
}
```

The `query` filters which PRs to claim (GitHub search syntax, e.g., `is:open author:@me label:bug`). See [`docs/sitters.md`](../sitters.md) for config details.

## Commands

**OpenCode**

```
/agentic-loop:pr-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:pr-sitter claim | status | stop
```

(Claude Code has no standing watcher; call `claim` again to pull the next PR.)

## Example: One-shot claim and fix

Manually invoke the loop once to fix the next actionable PR:

1. **Claim one PR**
   ```
   /agentic-loop:pr-sitter claim
   ```
   Polls your open PRs for failing checks, review comments, or merge conflicts. If it finds one, runs TRIAGE (assess the problem), then FIX (commit locally on the PR's existing branch — no push yet), then VERIFY (re-run checks), then PUBLISH (`git push origin <branch>` plus one `gh pr comment` per finding). PUBLISH never merges, closes, or approves — you review and merge by hand.

2. **Check status**
   ```
   /agentic-loop:pr-sitter status
   ```
   Shows which PR is being worked, or "idle" if none are actionable.

## Example: Standing watcher with hourly poll

Set up an ongoing watcher that checks every hour:

1. **Start the watcher**
   ```
   /agentic-loop:pr-sitter watch 1h
   ```
   (OpenCode only.) `watch` turns this session into the worker; it polls every 1 hour and claims one PR each time, fixing it unattended. Pressing ESC pauses it (keeps state); the next two steps need a separate session/terminal, or `unwatch`/ESC first.

2. **Check status while watching**
   ```
   /agentic-loop:pr-sitter status
   ```
   See which PR is being worked, or how many are queued.

3. **Stop the watcher**
   ```
   /agentic-loop:pr-sitter stop
   ```
   Stops watching and cleans up the background session.

## Learn more

- Full pipeline, sitter authority, config keys, and threat model: [`docs/sitters.md`](../sitters.md)
- Command reference: [`docs/opencode.md`](../opencode.md) (OpenCode), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Architecture: [`docs/architecture.md`](../architecture.md)
