---
name: code-simplification
description: Reduces complexity in working code while preserving behavior exactly — comprehension speed, not line count. Use when refactoring recently changed code for clarity.
---

# Code Simplification

> Inspired by the [Claude Code Simplifier plugin](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md). Adapted here as a model-agnostic, process-driven skill for any AI coding agent.

Reduce complexity while preserving exact behavior. Fewer lines is not the goal;
comprehension speed is — every simplification must pass one test: would a new
team member understand this faster than the original?

Simplify code that you understand and that is staying. Code you haven't
comprehended yet needs reading, not editing; code that is already readable needs
nothing; a measured hot path where the simpler form is slower stays as it is;
and a module you're about to rewrite is throwaway.

## The bar

Three invariants hold for every change in this skill:

**Behavior is preserved exactly.** Same output for every input, same error
behavior, same side effects in the same order — and all existing tests pass
**without modification**. A simplification you can't prove behavior-preserving
doesn't get made.

**The project's conventions win.** Simplification makes code more consistent
with its neighbours, not with your preferences: match the surrounding import
ordering, declaration style, naming, error handling, and type-annotation depth,
and read CLAUDE.md or the equivalent first. Simplification that breaks project
consistency is churn.

**Scope is what changed.** Default to recently modified code
(`using-agent-skills` → Maintain Scope Discipline). Unscoped simplification
creates diff noise and risks regressions in code nobody asked you to touch.

## Step 1: Understand before touching (Chesterton's Fence)

If you see a fence across a road and don't know why it's there, find the reason
before tearing it down — then decide whether the reason still applies.

Before changing or removing anything, answer:

```
- What is this code's responsibility?
- What calls it? What does it call?
- What are the edge cases and error paths?
- Are there tests that define the expected behavior?
- Why might it have been written this way? (Performance? Platform constraint? Historical reason?)
- What does git blame say about the original context?
```

Any unanswered question means you're not ready to simplify — go find the answer
before touching the code.

## Step 2: Find the signals

Scan for concrete signals rather than vague smells — deep nesting, long
functions, nested ternaries, boolean parameter flags, repeated conditionals,
generic or misleading names, comments explaining *what* instead of *why*,
duplicated logic, dead code, wrappers that add no value, and one-implementation
"patterns". Each signal and the simplification it calls for is catalogued in
`references/simplification-patterns.md` → Simplification Signals.

Comments explaining *why* ("Retry because the API is flaky under load") carry
intent the code can't express — those stay.

**Step 2 is done when** every signal you found is either queued for Step 3 or
has a documented reason to stay — a *why* comment, a proven hot path, or
similar.

## Step 3: Apply one change at a time

```
FOR EACH SIMPLIFICATION:
1. Make the change
2. Run the test suite
3. If tests pass → commit (or continue to the next simplification)
4. If tests fail → revert and reconsider
```

One change per test run: batching means a failure tells you something broke but
not which edit did it. Ship simplification separately from features and bug
fixes — a PR that refactors *and* adds a feature is two PRs.

**The Rule of 500:** a refactor that would touch more than 500 lines gets
automation — a codemod, a script, an AST transform. Manual edits at that scale
are error-prone and exhausting to review.

**Step 3 is done when** every simplification queued in Step 2 has been through
this cycle — applied and kept, or reverted.

## Step 4: Judge the result

Prefer clarity over cleverness: explicit code beats compact code whenever the
compact version costs a mental pause to parse. Worked before/after pairs live in
`references/simplification-patterns.md` → Clarity Over Cleverness.

Then check the opposite failure — over-simplification:

- **Inlined too aggressively** — a helper that gave a concept a name makes the
  call site *harder* to read once removed
- **Unrelated logic combined** — two simple functions merged into one complex
  function is not simpler
- **Abstraction removed that was earning its keep** — some exist for
  extensibility or testability, not complexity
- **Optimized for line count** — the goal was comprehension

Compare the whole before and after: is it genuinely easier to understand, is the
diff clean and reviewable, would a teammate approve it as a net improvement? If
the answer to any of these is no, revert — not every simplification attempt
succeeds.

**Done when** every signal found in Step 2 has passed through the Step 3 cycle
and Step 4's judgment on the result.

## Verification

- [ ] All existing tests pass **without modification** (a test you had to change
      means behavior changed)
- [ ] No error handling was removed or weakened
- [ ] Each simplification is a separate, reviewable change, with no feature or
      bug-fix work mixed in
- [ ] The simplified code matches the conventions of the code around it
