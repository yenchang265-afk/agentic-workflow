# Recurring work orders (`recurring` kind)

> **Experimental, opt-in.** Its manifest, definition format, and defaults may
> change between releases. Enable it with `"enabled": true` — see
> [configuration](configuration.md#workflow-kinds).

Everything else in this repo models work that ENDS. A backlog task walks
`draft → queued → plan-review → in-progress → in-review → completed` and stays
there; `completed`/`abandoned` are enforced dead ends in code. A sitter has no
durable object at all — it re-derives its work from live external state (a red
CI head, a vulnerable package, an open PR) every poll.

A **recurring work order** is neither. A human writes it once — a goal plus a
schedule — and it repeats its whole lifecycle on that schedule, forever, until
a human pauses or removes it. It is the only kind whose claimable identity is
fixed and re-claimed indefinitely.

Use it for standing jobs: a weekly changelog digest, a nightly flaky-test
sweep, a monthly dependency-report issue. Do **not** use it for one-off work
that happens to be slow — that is a backlog task.

## Where definitions live

A flat directory, `docs/recurring/` by default (`recurringDir`). No status
subfolders, because a definition has no status.

```
docs/recurring/
  f7k3-weekly-digest.md      ← the work order
  a1b2-flaky-sweep.md
  .runs/                     ← machine state; gitignore-shaped, not content
    f7k3-weekly-digest.json  ← ledger: when this order last RAN
    .claims/                 ← claim markers (one live cycle per definition)
```

One definition:

```yaml
---
title: Weekly changelog digest
schedule:
  type: cron
  expression: "0 9 * * MON"
  # timezone: Europe/London   # optional; UTC when unset
paused: false
acceptance:
  - A digest of everything merged since the last run is in the PR body
---
Summarize every PR merged to the default branch since the last run, grouped by
area, and put the summary in the pull request body.
```

or, on a plain interval:

```yaml
schedule:
  type: interval
  minutes: 1440
```

**Cron expressions are read in UTC unless `timezone` says otherwise.** This is
deliberate and worth knowing: definition files are committed to the repo and
polled by whichever machine happens to be watching. Inheriting the host's local
zone would make one committed schedule mean different wall-clock times per
machine — a bug you notice hours late, in the form of "the Monday job ran at
01:00". Say `timezone: Europe/London` when you mean local wall-clock time.

## What one cycle does

`plan → build → verify → review → publish`, with **no human gate anywhere in
between** — that is the point of scheduling it. The cycle:

1. plans against the repository as it is now (never against what a previous
   cycle did),
2. builds on a branch cut fresh for this cycle, `recurring/<id>-<run>`,
3. verifies and reviews it (a five-axis review, same contract as engineering's),
4. pushes and opens a **draft pull request**.

It never merges. Merging is the human decision the whole thing funnels into —
you review a PR per cycle instead of approving a plan and a ship every time.

Because each cycle gets its **own** branch, cycle 2 never resumes on cycle 1's
commits. (This matters more than it sounds: git tooling reuses an existing
branch as-is rather than resetting it, and a recurring order's goal text is
identical every cycle — so a branch name derived from the goal would collide
with itself every time.)

## Scheduling semantics

The ledger stores only `lastRunAt`; when a definition is next due is always
**recomputed** from that plus its current schedule. Edit the schedule and the
change takes effect on the very next poll — nothing cached to go stale.

- **Never run ⇒ due immediately.** Authoring an order is the request to start
  running it; waiting out a full interval (or until next Monday) before the
  first cycle reads as broken.
- **A missed window fires late rather than being skipped.** A watcher that was
  off overnight still runs this morning's 09:00 job when it comes back.
- **A transient failure keeps the slot.** If a cycle stops on an environment
  error or a human ESC, the ledger is untouched — the order is still due on the
  next poll.
- **A genuine failure consumes the slot.** If a cycle exhausts its iteration
  cap, `lastRunAt` advances and the order waits for its next natural
  occurrence, so a broken order does not hammer the loop every tick. Its
  `consecutiveFailures` count is surfaced so you can see it failing rather than
  having it quietly backed off into invisibility.
- **A broken schedule never fires.** A typo'd cron expression is reported as a
  warning on every poll, not treated as due (which would fire it constantly).

Only one cycle of a given definition runs at a time — the claim marker enforces
it, and a marker left behind by a crashed run is swept on the usual stale rules.

## Running it

Enable the kind and give it a poll cadence:

```json
{
  "workflows": {
    "recurring": {
      "enabled": true,
      "trigger": { "type": "poll", "intervalMinutes": 5 }
    }
  }
}
```

The kind's `trigger` controls **how often the registry is even looked at** — it
is not the schedule. Each definition's own `schedule` decides whether it is due
when that look happens, so keep the poll interval well under the shortest
schedule you care about (a 5-minute poll cannot notice an hourly job late, but
a 6-hour poll would).

Then `claim` once, or `watch` to keep it running. Both are the generic verbs
every kind has, scoped to this one:

```
/agentic-workflow:recurring watch
/agentic-workflow:recurring status
/agentic-workflow:recurring unwatch
```

## Guard rails

- A cycle's stages **cannot edit the registry** — not the definition, not the
  ledger. A stage that could rewrite its own work order could change its own
  schedule, un-pause itself, or delete the record deciding when it next runs,
  and none of that would be visible to the human who authored it. Definitions
  are changed by hand or through the recurring verbs, never from inside a cycle.
- The publish stage can only push `recurring/*` branches — the base branch is
  unreachable from it.
- Nothing merges, closes, or marks a PR ready for review.

## Pausing and removing

Set `paused: true` in the definition to stop it firing while keeping its
history (resuming picks up from the real `lastRunAt`, so it does not
immediately fire a catch-up cycle unless it is genuinely overdue). Delete the
file to remove it for good; its ledger goes with it.
