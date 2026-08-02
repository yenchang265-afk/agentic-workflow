English | [繁體中文](11-iteration-budget-prompts.zh-TW.md)

# 11 — Iteration budget in the stage prompts

**Status: implemented.** `iterationCap` + the `iterations` context key in
`packages/core/src/workflow/engine.ts`, sections in
`packages/core/workflows/engineering/stages/build.md` / `verify.md`; tests in
`engine.test.ts`.

## Context

`maxIterations` bounds the BUILD→VERIFY→REVIEW loop, and `promptContext` has
exposed `iteration` since the manifests landed — but no engineering prompt
used either. The agent doing the work was the one party that did not know the
budget: a re-build could not tell iteration 2-of-3 from 2-of-20, and the
final VERIFY did not know its FAIL text was about to become the run's last
word — the very text the human replan gate reads.

An agent that knows its budget behaves differently in the right direction:
it escalates strategy instead of re-rolling the same fix, and it writes its
final failure for the human who has to act on it.

## Design

- `iterationCap(manifest, config?)` in `engine.ts` is the ONE resolution of
  `manifest.maxIterations ?? config.maxIterations`, used by both `advance`'s
  stop decision and the prompt composition — the number the agent is told can
  never drift from the number the loop stops at.
- `promptContext` gains an optional `cap` and a new `iterations` context key
  (the existing string `iteration` is untouched — it is documented and a
  shape change would silently break `{{iteration}}`):
  `{ human, cap, final? }`, human-numbered (iteration 0 is "1"), with `final`
  truthy exactly when `iteration + 1 >= cap` — `advance`'s stop predicate.
- Gated on `iteration > 0` **and** a resolvable cap: the first fire of every
  stage stays byte-identical to the pre-budget prompt (the frozen parity
  oracle is untouched), a config-less compose (the hub's creator preview of a
  manifest that declares no cap) cannot render a number that might be wrong,
  and the message lands where it matters — a re-build after a FAIL.
- `build.md` renders "Iteration budget: this is iteration N of M", plus a
  FINAL-iteration warning that a check failure now stops the loop for human
  re-planning; `verify.md` warns only on the final iteration that its FAIL
  text is what the replan gate will read. Other kinds are untouched — the
  key renders nothing until a kind's template asks for it.

## Why not

- **Always-on section** — burns the byte-identical first-fire guarantee (and
  the parity oracle) for a message that has no content on iteration 1.
- **Reusing the `iteration` key** — turning the documented string into an
  object makes existing `{{iteration}}` interpolations silently render `""`.
- **A second inline `?? config.maxIterations` at the compose site** — the
  prompt's number and the stop's number must come from one function, or they
  drift the way the pass-mode contract once did (see AGENTS.md: "a focused
  pass's contract must match the passes that will run").
