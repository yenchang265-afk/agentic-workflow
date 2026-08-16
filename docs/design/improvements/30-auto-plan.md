English | [繁體中文](30-auto-plan.zh-TW.md)

# 30 — `--auto-plan` thins the plan gate per task

**Status: implemented.**

## The problem

Every task pays three human gates — task, plan, ship — and for chore-sized
work the plan review is a rubber stamp: the human reads a one-step plan for a
task they just wrote themselves and types `approve` again. Gate fatigue is
real, but every blunt remedy is worse: a repo-wide "skip the plan gate" knob
would thin the gate for the risky tasks too, and prose telling the
orchestrator to "continue if trivial" puts a control-flow decision on
whatever the model feels that run.

## What changed

- **The opt-in is per-task, explicit, and taken at the task gate**:
  `approve <id> --auto-plan` (typed verb on every host; `autoPlan` on
  `workflow_approve`, documented as "only when the user explicitly asked").
  `parseGateOptions` owns the flag; `approveTask` writes `autoPlan: true`
  into the task's frontmatter — in `TaskFrontmatterSchema`, because an
  off-schema key is destructive under zod's unknown-key stripping (same
  rationale as `epic`). The rewrite screens `unknownFrontmatterKeys` and
  degrades to a warning: the MOVE is what was asked for.
- **Consumption at the park, judged on the FILE**: when a PLAN drive parks a
  task whose plan-review file carries the flag, the plan gate is crossed
  deterministically — never as prose an orchestrator might skip. OpenCode:
  `autoAdvanceParkedPlan` (driver) runs after both park sites (the
  `plan <id>`/chained drive and the watch claim), approves via the shared
  gate, and queues the BUILD drive through the same `start-task` pending
  `claim <id>` uses; when it crosses the gate it suppresses the plan-gate ask
  (nothing left to ask). Claude/Qwen: `runPark` approves server-side and
  omits `gate` from its descriptor so the plan-gate-ask hook and the gate
  prose stay silent; `next` says to `workflow_start` — skipping that costs
  idle time only (the task sits build-ready for the next claim).
- **Every rejection or re-statement withdraws the opt-in**: `replanTask`
  clears the flag (a human who rejected one plan wants eyes on the revision),
  and a plain `approve` on a draft still carrying it clears it too — the
  approval is authoritative about what was asked THIS time, so a retask →
  re-approve cycle cannot inherit a stale opt-in. The SHIP gate is never
  automated, on any path.

## Sharp edges

- A park REFUSAL (plan contract) is untouched: the task returns to `queued/`
  plan-next and the next pass re-parks — and then auto-approves again. That
  is deliberate: the contract refusal is mechanical, not a human judgement,
  and the unattended retry is what the opt-in bought.
- Design 24's park-time check forecast ("N admitted for VERIFY") is skipped
  along with the gate — an armed task whose plan discovers zero admissible
  checks proceeds anyway. The fire-time provenance (audit note + metrics)
  still records it; the human accepted that trade at the task gate.
- The failed-approve arm falls back to the ordinary human gate on both hosts
  (descriptor with `gate`, warning toast) — auto-plan may never turn a
  working gate into a stuck task.
- OpenCode's `workflow_gate` plugin tool does not carry the flag yet — the
  typed verb and the MCP tool do; an agent-driven arm can follow if a real
  flow needs it.
