---
name: incremental-implementation
description: Delivers changes in thin vertical slices, each tested before expanding. Use when a change touches more than one file, or you're about to write a large amount of code at once.
---

# Incremental Implementation

Ship one **slice** at a time: implement the smallest complete piece, test it,
verify it, commit it, then expand. Each slice leaves the tree **green** — build
clean, full suite passing, typecheck and lint clean — so a failure always
points at the slice you just wrote.

A single-file, single-function change is already minimal; slice nothing.

## The slice cycle

For each slice:

1. **Implement** the smallest complete piece of functionality.
2. **Test** — run the suite; write a test if none covers the slice
   (`test-driven-development`).
3. **Verify** — tests pass, the build succeeds, and the behavior works when run.
4. **Commit** — atomic message (`git-workflow-and-versioning`). **Your caller
   overrides this step**: some forbid committing outright (the loop's BUILD
   stage leaves the tree uncommitted so the human reviews one diff), and some
   commit locally but never push (the sitter fix stages). When the caller says
   nothing, commit.
5. **Next slice** — carry forward, don't restart.

A slice that passes ~100 lines with no test run has stopped being thin: stop and
run step 2 before writing more.

**Done when** every slice in the task has been through the cycle and the
tree is green after the last one.

## Slicing

Default to **vertical slices** — one complete path through the whole stack, so
each slice delivers working end-to-end functionality:

```
Slice 1: Create a task  (DB + API + UI)     → user can create a task
Slice 2: List tasks     (query + API + UI)  → user can see their tasks
Slice 3: Edit a task    (update + API + UI) → user can modify tasks
Slice 4: Delete a task  (delete + API + UI) → full CRUD
```

Two variants when the default doesn't fit. Fire a **tracer bullet** first when
one piece carries most of the risk — prove the WebSocket connects before
building real-time updates on it, and a failure costs you one slice instead of
three. Slice **contract-first** when frontend and backend advance in parallel:
slice 0 defines the types and API contract, each side then builds against it
(the frontend on mock data matching the contract), and a final slice integrates
and tests end-to-end.

## Rules

**Simplicity first.** Before writing code, ask what the simplest thing that
could work is; after writing it, run the simplicity checks in
`using-agent-skills` → Enforce Simplicity. Three similar lines beat a premature
abstraction. Build the naive, obviously-correct version; optimize only once
tests prove it correct.

**Scope discipline** — `using-agent-skills` → Maintain Scope Discipline.
Something worth improving outside scope gets reported, not fixed:

```
NOTICED BUT NOT TOUCHING:
- src/utils/format.ts has an unused import (unrelated to this task)
- The auth middleware could use better error messages (separate task)
→ Want me to create tasks for these?
```

**One thing at a time.** Each slice changes one logical thing. A new component,
a refactor of an existing one, and a build-config update are three slices and
three commits.

**Revertable.** Each slice stands alone under `git revert`: prefer additive
changes, keep edits to existing code minimal and focused, pair every migration
with its rollback, and split "delete the old thing" from "add the new one" into
separate slices.

**Flag what isn't ready.** A feature that must merge before it's user-ready
ships behind an environment-driven flag that defaults off, so increments reach
the main branch without exposing incomplete work.

## Verification

- [ ] Each slice was individually tested, and committed if your caller allows it
- [ ] The tree is green after the final slice
- [ ] The feature works end-to-end as specified, confirmed by running it
- [ ] No uncommitted changes remain — unless your caller forbids committing, in
      which case the whole change stays uncommitted for its reviewer

One clean run per code state — see `references/definition-of-done.md` →
Verification Discipline. Per-slice verification is the local check; before
declaring the task done, apply the project-wide Definition of Done in that same
file as the final gate.
