# dep-sitter

Sits on vulnerable and outdated dependencies: confirms the advisory, applies the patch/minor upgrade on a branch, fixes the fallout, verifies the suite is green, and opens a draft PR. **Major bumps are never auto-fixed and merging stays a human call.**

SCAN → UPGRADE → VERIFY → PUBLISH (up to 2 iterations)

## Enable

Add to `.agentic-loop.json`:

```jsonc
{
  "loops": {
    "dep-sitter": {
      "enabled": true,
      "severityFloor": "high"
    }
  }
}
```

The `severityFloor` filters which advisories trigger fixes (e.g., `high`, `critical`). See [`docs/sitters.md`](../sitters.md) for all config options.

## Commands

**OpenCode**

```
/agentic-loop:dep-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:dep-sitter claim | status | stop
```

(Claude Code has no standing watcher; call `claim` again to pull the next dependency.)

## Example: One-shot scan and upgrade

Manually check for vulnerable dependencies and fix one:

1. **Claim one dependency**
   ```
   /agentic-loop:dep-sitter claim
   ```
   Polls dependency reports (npm `audit`/`outdated`, Maven/Gradle via OSV-Scanner) for the next fixable advisory. Runs SCAN (confirm the advisory), UPGRADE (apply the patch/minor bump), VERIFY (run the test suite), then PUBLISH (open a draft PR with the bumped lockfile). You review and merge by hand.

2. **Check status**
   ```
   /agentic-loop:dep-sitter status
   ```
   Shows which dependency is being upgraded, or "idle" if none are pending.

## Example: Weekly scheduled scan

Set up a cron job to scan and fix dependencies every Monday at 9 AM:

1. **Start the cron-triggered watcher**
   ```
   /agentic-loop:dep-sitter watch cron "0 9 * * 1"
   ```
   (OpenCode only.) `watch` turns this session into the worker; it fires on the cron schedule and claims one dependency each time. Useful for regular security hygiene.

2. **Stop the watcher**
   ```
   /agentic-loop:dep-sitter stop
   ```
   Run from a separate session/terminal (the watching session is occupied), or press ESC/`unwatch` first.

## Learn more

- Full pipeline, dependency sources, and config: [`docs/sitters.md`](../sitters.md)
- Security posture and threat model: [`docs/design/threat-model.md`](../design/threat-model.md)
- Command reference: [`docs/opencode.md`](../opencode.md) (OpenCode), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Architecture: [`docs/architecture.md`](../architecture.md)
