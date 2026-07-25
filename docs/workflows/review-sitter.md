English | [繁體中文](review-sitter.zh-TW.md)

# review-sitter

Sits on pull requests where your review is requested: reads the diff in the context of the surrounding code and posts one structured review comment per requested head. **Never approves, requests changes, or merges — the human reviewer stays the reviewer of record.**

FETCH → ASSESS → PUBLISH (no retry loop)

## Enable

Always on — nothing to add to `.agentic-workflow.json` to use it, and no way
to turn it off (`"enabled": false` here is a config error). To narrow what it
claims:

```jsonc
{
  "workflows": {
    "review-sitter": { "query": "is:open review-requested:@me" }
  }
}
```

The default query (`is:open review-requested:@me`) is overridable via `workflows.review-sitter.query` (GitHub-only, like pr-sitter's). See [`docs/sitters.md`](../sitters.md) for all config options.

## Commands

**OpenCode**

```
/agentic-workflow:review-sitter claim [<pr>] | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-workflow:review-sitter claim [<pr>] | status | stop
```

(Claude Code has no standing watcher; call `claim` again to pull the next PR.)
Pass a specific PR — a number (`42`), `#42`, or a PR URL — to **force** that
one: it is fetched directly and reviewed even with no outstanding request and
even if its head was already reviewed, overriding the query and dedup ledger.
Fork PRs are still refused.

## Architecture

Sits on **other people's** PRs where your review is requested — never your
own. Work source `pull-request` with `role: reviewer`, query
`is:open review-requested:@me` (overridable with `workflows.review-sitter.query`,
GitHub only); on ADO it claims active PRs where `ado.selfLogin` is a reviewer
with a pending vote (vote 0). **fetch** (read-only) → **assess** (worktree;
reads the diff in the context of the surrounding code, may run the suite) →
**publish** posts **one structured review comment** per requested head.
Authority is **comment-only** — it never approves, requests changes, or
merges, so the human stays reviewer of record. Re-fires only when a human
pushes a new head; fork and draft PRs are skipped. Passing a `target` PR
bypasses both the review-requested query and the already-reviewed ledger — the
PR is fetched directly and reviewed afresh even without a new head — but a fork
head is still refused.

- **`workflows.review-sitter.enabled`** — default off.
- **`workflows.review-sitter.query`** — GitHub only; default
  `is:open review-requested:@me`.

## Example: One-shot review of a PR

Manually invoke the loop to review one pending PR:

1. **Claim one PR**
   ```
   /agentic-workflow:review-sitter claim
   ```
   Polls for the next PR where your review is requested. Runs FETCH (get the diff), then ASSESS (read the code and write a review), then PUBLISH (post the review as a comment). The comment includes observations, questions, and/or suggestions, but never approves or requests changes — you remain the reviewer of record.

2. **Check status**
   ```
   /agentic-workflow:review-sitter status
   ```
   Shows which PR is being reviewed, or "idle" if none are pending.

## Example: Idle watcher for continuous review

Let the loop watch and review PRs automatically whenever you're idle:

1. **Start the idle-triggered watcher**
   ```
   /agentic-workflow:review-sitter watch idle
   ```
   (OpenCode only.) `watch` turns this session into the worker; it claims a new review every time the session goes idle, instead of on a fixed timer. Useful if you want reviews posted without setting a schedule.

2. **Stop the watcher**
   ```
   /agentic-workflow:review-sitter stop
   ```
   Run from a separate session/terminal (the watching session is occupied), or press ESC/`unwatch` first.

## Learn more

- What all four sitters share, and the threat model: [`docs/sitters.md`](../sitters.md), [`docs/design/threat-model.md`](../design/threat-model.md)
- Command reference: [`docs/opencode.md`](../opencode.md) (OpenCode), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Framework internals: [`docs/architecture.md`](../architecture.md)
