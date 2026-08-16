English | [繁體中文](28-claim-by-id.zh-TW.md)

# 28 — `claim` takes a task id

**Status: implemented.**

## The problem

A backlog with several build-ready tasks offered no way to say "build THIS
one". Bare `claim` walks the pools in priority order — build-ready
`in-progress/` work first, then a planless `queued/` task — and the walk
chooses for you. Worse, the verbs pointed at each other in a circle:
`plan <id>` refused a build-ready id with "claim builds it", and `claim`
could not target an id at all. The machinery was half-built on both hosts:
the Claude host's `workflow_start({id})` already claims one specific task
(BUILD entry for `in-progress/`, PLAN entry for `queued/`) but no verb
routed to it, and the OpenCode driver's `start-task` pending had consumer
arms in `onIdle` (`markClaimedOnHumanBranch` + a BUILD-entry drive) with no
producer anywhere — dead code waiting for exactly this feature. The PR
sitters' `claim <pr>` had already established that a claim can take a
target; engineering was the one kind whose claim could not.

## What changed

- **OpenCode** — `startTaskById` in
  `plugins/opencode/src/workflow/driver.ts`, the missing `start-task`
  producer: the claim branch of `handleCommand` routes a non-empty payload on
  the engineering kind to it (PR-shaped kinds keep the `<pr>` parse; other
  sitters keep the "takes no argument" refusal). It holds the same guards as
  `plan <id>` — the busy guard, short-hash resolution, `findSessionDriving`,
  the atomic `claimTask` race — and mirrors `recover`'s split on a
  non-claimable `in-progress/` task (started → `recover <id>`, planless →
  `replan <id>`). A `queued/` id goes through `claimForPlan`, so it behaves
  exactly like `plan <id>` (plan-request consumed, `askOnPark` set — a human
  naming a task is sitting at the session). Any other folder is refused with
  the verb to use instead.
- **Claude Code / Qwen** — no server change: the `claim` verb block in
  `prompts/verbs/engineering.md` now routes an id to the existing
  `workflow_start({id})` and stays on `workflow_claim` bare; regenerated into
  both hosts' `verbs/engineering.md`.
- **Surface** — `claim [id]` in every host's `argument-hint`, usage string,
  and the docs that describe the verb; `plan <id>`'s build-ready refusal now
  names `claim <id>` instead of the priority walk that could not target it.

## Sharp edges

- The refusal messages for `completed`/`abandoned` say "nothing to run"
  rather than inviting a re-claim: a finished task's re-run path is a new
  task, not a second drive on a shipped branch.
- `startTaskById` re-checks the busy guard even though the claim branch
  already did — the function must hold on its own for any future caller.
