---
name: planning-and-task-breakdown
description: Plans work before it is built — decomposing a goal into ordered, verifiable tasks, or writing the executable plan for one already-scoped task. Use when a spec needs breaking down, or when a scoped task needs its plan before execution.
---

# Planning and Task Breakdown

A plan earns its keep when the builder can follow it without re-deciding
anything. That property is **executable**, and it is what both branches below
are aiming at — one across a goal, one within a single task.

| Branch | You have | You produce |
|---|---|---|
| **Decompose** | a goal or spec too big to build in one pass | ordered, independently verifiable tasks |
| **Plan one task** | one already-scoped task, about to be built | the executable plan for that task |

**When NOT to use:** a single-file change whose scope is already obvious, or a
spec that already contains well-defined tasks.

---

# Branch A — decompose a goal into tasks

## Map the dependency graph

Map what depends on what:

```
Database schema
    │
    ├── API models/types
    │       │
    │       ├── API endpoints
    │       │       │
    │       │       └── Frontend API client
    │       │               │
    │       │               └── UI components
    │       │
    │       └── Validation logic
    │
    └── Seed data / migrations
```

Implementation order follows the graph bottom-up: build foundations first.

## Slice vertically

Instead of building all the database, then all the API, then all the UI — build
one complete feature path at a time:

**Horizontal (avoid):**
```
Task 1: Build entire database schema
Task 2: Build all API endpoints
Task 3: Build all UI components
Task 4: Connect everything
```

**Vertical (aim for):**
```
Task 1: User can create an account (schema + API + UI for registration)
Task 2: User can log in (auth schema + API + UI for login)
Task 3: User can create a task (task schema + API + UI for creation)
Task 4: User can view task list (query + API + UI for list view)
```

Each vertical slice delivers working, testable functionality.

> **In the agentic loop:** these vertical slices become **sibling draft
> tasks**. `/agentic-workflow:engineering new` splits a heavy idea into one draft per slice
> (each built in its own worktree context, so each stays reviewable in one
> sitting) plus a `type: epic` tracking draft. See `task-backlog-management` →
> "Slicing a heavy idea".

## Size each task

| Size | Files | Scope | Example |
|------|-------|-------|---------|
| **XS** | 1 | Single function or config change | Add a validation rule |
| **S** | 1-2 | One component or endpoint | Add a new API endpoint |
| **M** | 3-5 | One feature slice | User registration flow |
| **L** | 5-8 | Multi-component feature | Search with filtering and pagination |
| **XL** | 8+ | Split it — see the tests below | — |

An agent performs best on S and M tasks. Split a task further when any of these
holds:

- It would take more than one focused session (roughly 2+ hours of agent work)
- Its acceptance criteria need more than 3 bullets to state
- It touches two or more independent subsystems (e.g. auth and billing)
- Its title contains "and" — a sign it is two tasks

## Write each task

```markdown
## Task [N]: [Short descriptive title]

**Description:** One paragraph explaining what this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: `npm test -- --grep "feature-name"`
- [ ] Build succeeds: `npm run build`
- [ ] Manual check: [description of what to verify]

**Dependencies:** [Task numbers this depends on, or "None"]

**Files likely touched:**
- `src/path/to/file.ts`
- `tests/path/to/test.ts`

**Estimated scope:** [Small: 1-2 files | Medium: 3-5 files | Large: 5+ files]
```

## Order and checkpoint

Arrange tasks so that dependencies are satisfied, each task leaves the system in
a working state, and high-risk tasks come early (fail fast). Place a checkpoint
after every 2-3 tasks:

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass
- [ ] Application builds without errors
- [ ] Core user flow works end-to-end
```

> **Writing this up as a standalone plan document** — one covering multiple
> phases, or one where some tasks can run concurrently — needs the multi-task
> template and the parallelization rules in `references/project-plan-template.md`.

## Verification — branch A

- [ ] Every task has acceptance criteria and a verification step
- [ ] Every task names the files it is likely to touch
- [ ] Task dependencies are stated and the order satisfies them
- [ ] No task is sized L or larger
- [ ] A checkpoint sits between each pair of phases

---

# Branch B — plan one task for execution

The reader of this plan implements it **literally** and does not redesign it, so
a step that is vague or wrong costs a whole build iteration out of a budget of a
few. Every decision belongs in the plan, not in the build.

## Steps

1. **Read first.** Skim the relevant code and docs until you know what already
   exists and what "done" plausibly means here. _Done when:_ you can name the
   files the change lands in without guessing.
2. **Sharpen and bound.** State the concrete problem, and state what is
   explicitly out of scope. _Done when:_ both are written and the out-of-scope
   list names at least the nearest adjacent thing you chose not to touch.
3. **Reuse-first.** Build the plan around existing functions, utilities, and
   patterns; cite each as `file:line`. _Done when:_ every step either cites the
   thing it reuses or says why nothing existing fits.
4. **Right-size.** Keep it reviewable by a human in one sitting. If the goal is
   larger than that, order it into slices and plan only the first — the rest go
   back to branch A.
5. **Be concrete.** Name the exact files to create or modify and the change in
   each. _Done when:_ no step says "update the relevant code".
6. **On a replan**, read why the prior plan failed or was rejected, and address
   that directly. _Done when:_ the new plan states what the prior one got wrong
   and what it does differently — a plan that merely sits beside the old one
   repeats its failure.

## The plan's shape

```md
## Implementation Plan

**Problem** — the concrete thing being fixed or built.
**Non-goals** — what this deliberately does not touch.
**Assumptions** — what you took as true without confirming.

### Steps
1. `path/to/file.ts` — the change.
2. …

**Acceptance criteria** — mirroring or refining the task's own bullets.
**Reuse** — `file:line` for each existing thing the steps build on.
**Risks** — what could make this fail, and the early signal for each.
```

Trim any part that would be a mere restatement. If the task cannot be planned as
stated, say so plainly in the plan rather than inventing a scope that fits.

> Writing this onto a backlog task file has a heading contract and a frontmatter
> contract — see `task-backlog-management` → "Task file schema".

## Verification — branch B

- [ ] Every step names the files it touches and the change in each
- [ ] Every acceptance criterion traces to at least one step
- [ ] Every reuse claim carries a `file:line`
- [ ] Non-goals name what was deliberately left out
- [ ] On a replan, the plan states what the prior one got wrong
- [ ] Nothing in the plan requires the builder to make a design decision

---

## See Also

Acceptance criteria are per-task and answer "did we build the right thing?". They sit on top of the project-wide Definition of Done, the standing bar every task clears before it counts as done. See `references/definition-of-done.md`.
