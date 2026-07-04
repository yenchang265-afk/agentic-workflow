# Agentic loop — engineering workflow improvement plans

Implementation plans for the next round of improvements to the `/loop`
pipeline, written to be executed later (each is sized to be one `/loop` task
or one PR, and is self-contained — no conversation context required).

Sourced from: the current code on `enterprise-hardening` (all cited paths and
function names verified against source), the residual risks in
[`../threat-model.md`](../threat-model.md), and the documented limitations in
`README.md` / `skills/loop-orchestration/SKILL.md`.

## The plans, in recommended execution order

| # | Plan | What it buys | Attacks |
|---|------|--------------|---------|
| 01 | [Worktree isolation](./01-worktree-isolation.md) | Human's checkout never touched; safe concurrent watch sessions in one instance | Threat model T3 residual; `executingDirs` serialization |
| 02 | [State persistence](./02-state-persistence.md) | Crash/restart resumes at the exact stage with artifacts, not a re-plan | In-memory-only `LoopState` limitation |
| 03 | [Ship + status commands](./03-ship-and-status-commands.md) | Audited `in-review → completed` move; backlog dashboard | Unaudited manual `mv`; no backlog overview |
| 04 | [Verdict quality](./04-verdict-quality.md) | Structured failure reasons feed re-plans; optional multi-lens review | Prose-blob feedback loops; threat model T1 residual |
| 05 | [Secret redaction](./05-secret-redaction.md) | Secrets scrubbed from durable artifacts before write | Threat model T6 (currently only partial) |
| 06 | [Run metrics](./06-run-metrics.md) | Per-run stage timings + verdict history in the run log | No convergence visibility |

Order rationale: 01 first — everything else compounds on safe parallelism, and
02's snapshot format wants 01's `GitRef.worktree` field to exist. 03 is
independent and cheap (can be done any time). 04–06 are independent of each
other.

## Conventions every plan follows

- **TDD**: each plan lists the failing tests to write first. The suite must
  stay green with all new config knobs unset (backward compatibility is a
  hard requirement — every feature here is opt-in or purely additive).
- **Purity boundary**: `src/loop/state.ts` and the predicate helpers in
  `src/task/store.ts` stay pure. Anything that touches the shell, clock, or
  filesystem lives in `driver.ts`, `git.ts`, `store.ts`'s IO half, or a new
  impure module.
- **Docs are part of done**: each plan ends with the exact docs to update
  (`README.md`, `.opencode/commands/loop.md`,
  `skills/loop-orchestration/SKILL.md`,
  `skills/task-backlog-management/SKILL.md`, `docs/design/threat-model.md`)
  so the earlier `in-review`-style doc drift doesn't repeat.
