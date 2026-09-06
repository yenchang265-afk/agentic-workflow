English | [繁體中文](68-build-test-rule-scope.zh-TW.md)

# 68 — The failing-test-first rule is scoped to behaviour

**Status: implemented.**

## The problem

The BUILD persona demanded "a failing test per acceptance criterion (per
review finding, on a re-build)" — unconditionally. A rebuild driven by a
readability, architecture, docs or naming finding, or a security hardening
with no exploitable path, therefore had two honest outcomes: a tautological
test (which VERIFY then fails) or silent non-compliance. `AxisFinding`
carries no behavioural flag; the only structured signal reaching BUILD is
the axis name, already rendered on its own line by `verdictFeedbackBlock`.

## What changed

- **`prompts/agents/workflow-build/body.md` step 2** now demands the failing
  test first for every acceptance criterion and for every finding whose fix
  changes observable behaviour — a `correctness` or `performance` finding,
  any reproducible defect — and forbids a manufactured test for a finding
  that changes none, asking instead for a Test-status line naming the
  existing tests that guard the change. A tautological test written to
  satisfy the rule fails VERIFY.
- Regenerated into every host's agent file by `gen:prompts`.

## Sharp edges

- **Keyed on the axis name, no schema change.** A `behavioral` flag on
  `AxisFinding` would touch the `workflow_verdict` schemas on both hosts and
  every contract branch; the axis line is already there and is the coarser
  but sufficient signal. Revisit only if it proves too coarse.
- **Persona, not stage template.** The rule lives in the agent body, which
  the composition oracle does not model, so no oracle edit.
