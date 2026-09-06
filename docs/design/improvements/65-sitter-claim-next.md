English | [繁體中文](65-sitter-claim-next.zh-TW.md)

# 65 — A sitter's terminal says what is still waiting

**Status: implemented.**

## The problem

`pollOnce` returns the FIRST claim and every source `return`s on it,
discarding the rest of the candidate set it had just evaluated. A sitter's
terminal was therefore a bare message — "PR #7: review passed" — with no
word about PRs #8 and #12 that needed attention on the same walk: a
one-shot `claim` ended there, and a watch session went quiet until its next
tick.

## What changed

- **`WorkItem.remaining?: number`**: how many more items the source would
  have claimed on the same walk, counted WITHOUT claiming or fetching them.
  `github-pr` and `ado-pr` re-run their attention judgement over the tail;
  `dependency-scan` counts the ledger-open candidates behind the claimed
  one. Absent where the source cannot tell (the backlog has `status`; a
  single-head source has nothing behind it).
- **OpenCode**: after a claimed drive's `done`/`stop`, a log line and toast
  name the count and the next step — the kind's `claim` verb, or "this watch
  session takes the next one on its next tick".
- **Claude/Qwen**: the terminal result of `workflow_advance` carries
  `remaining` and a `next` naming `workflow_claim({kind})`.

## Sharp edges

- **Counted, never claimed.** Taking markers for the tail would hold work
  no drive is about to do; a count is a hint, not a lease.
- **Bounded where judgement costs a call.** GitHub's attention test re-runs
  over data `gh pr list` already returned; ADO's snapshot fetches threads
  and pipelines per PR, so `ado-pr` judges at most `REMAINING_PROBE_MAX`
  (5) eligible tail PRs and the count is a lower bound past that.
- **Not for the backlog.** Engineering's board has `status` and the claim
  walk's own skip reasons; a task count here would duplicate them.
