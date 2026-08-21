# Agent Teams: competing-hypothesis debugging

The worked example split out of `references/orchestration-patterns.md`, which
owns the catalog this one branch sits in — Pattern 3 (parallel fan-out with
merge), the anti-patterns, and the decision flow. This file is only the case for
reaching past a fan-out to **Agent Teams**: an investigation whose hypotheses
have to argue with each other.

This example shows when to reach for **Agent Teams** instead of a subagent fan-out (Pattern 3). The two patterns look similar from a distance — both spawn three investigators — but the value comes from a different place. This repo has no named specialist personas outside the loop's own lifecycle stages, so the teammates below are Claude Code's built-in `general-purpose` agent type, each given a distinct investigation-angle prompt rather than a custom persona name.

## The scenario

> *Checkout occasionally hangs for ~30 seconds before completing. It happens roughly once every 50 sessions. No errors in logs. Started after last week's release.*

Plausible root causes (mutually exclusive, all fit the symptoms):

1. A race condition in the new payment-confirmation flow
2. An auth check that occasionally falls through to a slow synchronous network call
3. A missing index on a query that scales with cart size
4. A flaky third-party API where the SDK retries silently before timing out

A single agent will pick the first plausible theory and stop investigating. A Pattern-3-style subagent fan-out would have each investigator report independently — but their reports never meet, so nothing rules out the wrong theories.

This is exactly the case the Agent Teams docs describe: *"With multiple independent investigators actively trying to disprove each other, the theory that survives is much more likely to be the actual root cause."*

## Why this is *not* a Pattern-3 job

| | Pattern 3 (subagent fan-out) | Agent Teams |
|--|--------------------|-------------|
| Sub-agents see | The same artifact, different lenses | A shared task list, each other's messages |
| Output | Independent reports → one merge | Adversarial debate → consensus root cause |
| Right when | You want a verdict on a known artifact | You want to *find* the artifact among hypotheses |

Pattern 3 is a verdict; Agent Teams is an investigation.

## Setup (one-time, per-environment)

Agent Teams is experimental. In `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Requires Claude Code v2.1.32 or later. No team-config files to author by hand — teammates are spawned ad hoc from the trigger prompt.

## The trigger prompt

Type into the lead session, in natural language:

```
Users report checkout hangs for ~30 seconds intermittently after last
week's release. No errors in logs.

Create an agent team to debug this with competing hypotheses. Spawn
three general-purpose teammates, each with a distinct investigation angle:

  - investigate race conditions and blocking calls in the checkout
    code path (Promise.all ordering, await gaps)
  - investigate auth checks, session handling, and any synchronous
    network calls added recently
  - propose tests that would distinguish between the hypotheses and
    check coverage gaps in checkout

Have them message each other directly to challenge each other's
theories. Update findings as consensus emerges. Only converge when
two teammates agree they can disprove the others'.
```

The lead spawns three `general-purpose` teammates, each with its investigation angle folded into its task prompt (this repo has no standing specialist personas to reference by name outside the loop's own stage agents). The trigger prompt above becomes each teammate's task.

## What happens

1. Each teammate runs in its own context window, exploring the codebase from its own lens.
2. Teammates use `message` to send findings to each other directly. The lead doesn't have to relay.
3. The shared task list shows who's investigating what — visible at any time with `Ctrl+T` (in-process mode) or in a tmux pane (split mode).
4. When the race-condition investigator finds a `Promise.all` that should be sequential, it messages the auth investigator to confirm the auth call isn't part of the race. That teammate checks and replies — either confirming the race is the real issue or producing counter-evidence.
5. The test investigator proposes a focused integration test for whichever theory is winning, which the team uses to verify before declaring consensus.
6. The lead synthesizes the converged finding and presents it to you.

You can interrupt at any teammate by cycling with `Shift+Down` and typing — useful for redirecting an investigator who's gone down a wrong path.

## When to clean up

When the investigation lands on a root cause, tell the lead:

```
Clean up the team
```

Always cleanup through the lead, not a teammate (per the docs: teammates lack full team context for cleanup).

## Cost expectation

Three Sonnet teammates running for ~10–15 minutes of investigation costs noticeably more than the same three investigators spawned as subagents (Pattern 3). The justification is *quality of conclusion* — for production debugging where the wrong fix is expensive, the extra tokens are a bargain. For a routine review, stick with a subagent fan-out.

## Anti-pattern in this scenario

Do **not** rebuild this as a slash command that fans out subagents. Subagents can't message each other — you'd lose the adversarial debate that makes the pattern work. If a workflow keeps coming up, document the trigger prompt above as a snippet rather than wrapping it in a slash command that misuses subagents.

## When *not* to use Agent Teams

- Production-bound verdict on a known diff → use a subagent fan-out (Pattern 3), e.g. a `stageFanout` review.
- One specialist perspective on one artifact → direct persona invocation.
- Sequential lifecycle (plan → build → verify → review) → user-driven slash commands (Pattern 4).
- Read-heavy research with a small digest → built-in `Explore` subagent.

Reach for Agent Teams only when teammates **need** to challenge each other to produce the right answer.
