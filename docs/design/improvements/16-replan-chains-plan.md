English | [繁體中文](16-replan-chains-plan.zh-TW.md)

# 16 — Replan chains the re-plan

**Status: implemented.** `markPlanNext`/`replanQueued` and the `data.id`
payload in `packages/core/src/workflow/gate.ts`, `source` on `requestPlan` in
`task/plan-request.ts`, `claimForPlan` + the chained `handleReplan` in
`plugins/opencode/src/workflow/driver.ts`, `continueTurn` on replan in
`plugins/claude/hooks/gate-parse.mjs` with the rewritten verb block in
`prompts/verbs/engineering.md`; `gate.test.ts`, `plan-request.test.ts`,
`driver.test.ts`, `gate-parse.test.mjs`.

## Context

`replan [id] [reason]` rejected a parked plan and moved the task back to
`queued/` — where it **sat**. Nothing re-planned it until a human typed
`plan <id>` or a claim/watch walk happened to reach it behind every other
queued task. The gate's purpose is a REVISED plan for the human to re-review,
so every rejection cost one manual follow-up (or an unbounded wait), and the
rejection reason — already threaded into the next PLAN pass's prompt by plan
10 — went unread until then.

Keeping the task *in* `plan-review/` while re-planning was rejected: `runPark`
and `runStop` hardcode that a PLAN-stage task lives in `queued/`
(`terminal.ts`), the PLAN claim pool IS `queued` and `plan-review` is not a
pool, `canTransition` only enters `plan-review` from `queued`, and the
doctor's claim/request sweeps are keyed to pool folders. The task therefore
still **transits** `queued/`; what changed is that the transit is no longer a
parking spot.

## Design

- **Core stamps plan-next.** After its move + commit, `replanTask` writes the
  existing plan-request marker (`queued/.requests/<id>`, `source: "replan"`)
  via `markPlanNext` — best-effort, warned on failure, written AFTER the
  commit so the ephemeral marker never rides into a tracked backlog's replan
  commit. Every worker honours it already (`requestedFirst` in the claim
  walk), so even the host that cannot chain gets "re-planned first".
  `data.id` is returned (and the id rides in the `message`) because the hosts
  chain from it.
- **OpenCode chains in-process.** `handleReplan` follows a successful
  rejection with the same claim + `setPending({kind:"start-plan"})` primitive
  `plan <id>` uses (`claimForPlan`, extracted so the two cannot drift). A busy
  session, a rival's claim, or a stale core dist (no `data.id`) falls back to
  reporting core's plan-next outcome — the rejection itself is never blocked
  by the chain.
- **Claude/Qwen chain via the hybrid-verb path.** replan's dispatch gains
  `continueTurn: true` (retask's precedent): the hook still performs the
  deterministic reject, then hands the turn back with the outcome plus the
  replan verb block, which now instructs exactly ONE PLAN pass
  (`workflow_start({id})` → `workflow-plan-author` → `workflow_advance`) and
  nothing else. A model that never follows through leaves the deterministic
  plan-next marker as the backstop.
- **The hub does not chain** — it never drives a stage (its charter). Its
  replan now lands the card as "queued + plan requested", with the existing
  Cancel-plan-request button as the opt-out.
- **A replan aimed at an already-queued task** (`replanQueued`) records the
  fresh reason as the canonical rejection note and restamps plan-next —
  unless the task is claim-held in `queued/`, i.e. a planner holds the file
  RIGHT NOW: appending under it is a lost update, and that run is already
  doing what the verb asks, so the arm refuses with "being planned right
  now".

Unchanged on purpose: `planRejectedNote`'s exact prose (it is
`extractReplanReason`'s parse anchor, and still true — the transit happens),
the refusal arms (live loop, claim marker), and PLAN's replace-in-place
contract.

## Verification

`gate.test.ts` pins the marker stamp on both origins, the already-queued
restamp, the claim-held-queued refusal, and that a failed move stamps
nothing; `driver.test.ts` pins the chained claim, the busy-session and
claim-race fallbacks; `gate-parse.test.mjs` pins `continueTurn`;
`packages/hub`'s `gate.test.ts` pins the marker landing from both hub
origins.
