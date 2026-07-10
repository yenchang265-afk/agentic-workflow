# AGENTS.md — <project name>

<!--
  Starter AGENTS.md for projects driven by the agentic-loop plugin.

  How to use:
  1. Copy this file to your repo root as `AGENTS.md` (OpenCode) or `CLAUDE.md`
     (Claude Code) — or symlink one to the other.
  2. Fill in every `<placeholder>` and delete these comments.
  3. Keep it short. Agents read this file on every session; every line here
     costs context. State facts an agent cannot derive from the code, and
     rules you actually want enforced.
-->

Guidance for AI coding agents working in this repository.

## Project Facts

- **What this is:** <one-line purpose, e.g. "REST API for invoice processing">
- **Stack:** <language, framework, package manager, e.g. "TypeScript, Fastify, npm">
- **Layout:** <2–4 bullets on where things live, e.g. "src/ app code, tests/ mirrors src/, docs/ design notes">

### Commands (run these — definition of done)

```bash
<install command>        # e.g. npm install
<typecheck/lint command> # e.g. npm run typecheck && npm run lint
<test command>           # e.g. npm test
<build command>          # e.g. npm run build (omit if none)
```

A change is **done** only when typecheck, lint, and tests are all green and
the changed behavior has been exercised end-to-end (run the app, hit the
endpoint, click the flow — not just unit tests).

## Core Rules (Karpathy)

Derived from Andrej Karpathy's observations on LLM coding pitfalls. These
bias toward caution over speed; for trivial tasks, use judgment.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.
- The test: every changed line traces directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."
- For multi-step tasks, state a brief plan (`step → verify: check` per line).
- Strong success criteria let you loop independently; weak ones ("make it
  work") force constant clarification.

## Loop vs Ad-hoc

Two execution modes. Pick by scope, not habit.

**Use the agentic loop** when a goal is multi-step and should run largely
unattended (a feature, a refactor with tests, anything worth a task file):

1. `/agent-loop-task new <idea>` — interview produces a draft task with the
   goal and testable acceptance criteria (always from you, never guessed)
2. Review the draft, then `/agent-loop-task approve <id>` — queues it
3. `/agent-loop task <id>` (or a `watch` worker) claims the queued task,
   writes the `## Implementation Plan` right before execution, and parks it
   at the plan gate
4. `/agent-loop-task approve-plan <id>` (or `replan <id> [why]`) — after
   approval the loop runs BUILD→VERIFY→REVIEW unattended on a `feature/<id>`
   branch; you review the result and `/agent-loop ship <id>`

At the plan and ship gates, **`/agent-loop approve`** advances the one task the loop
is waiting on and **`/agent-loop reject`** bounces a parked plan back — the explicit
`<id>` verbs above stay the unambiguous form when more than one task waits. (Draft
approval is `/agent-loop-task approve <id>`.)

**Stay ad-hoc** for a single bounded request (rename, small fix, question):
invoke the matching skill directly and follow it exactly.

## Lifecycle (both modes)

| Stage  | Skill(s)                                              | Exit criteria                                  |
|--------|-------------------------------------------------------|------------------------------------------------|
| PLAN   | `spec-driven-development`, `planning-and-task-breakdown` | Spec/plan exists; tasks small and verifiable |
| BUILD  | `incremental-implementation`, `test-driven-development`  | Tests written first; all pass                |
| VERIFY | `debugging-and-error-recovery`                           | Behavior exercised end-to-end; commands green |
| REVIEW | `code-review-and-quality`                                | Review findings addressed or explicitly waived |

## Intent → Skill Mapping

If a task matches a skill, invoke it — never implement directly when one applies.

- Feature / new functionality → `spec-driven-development`, then `incremental-implementation` + `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or interface design → `api-and-interface-design`
- UI work → `frontend-ui-engineering`
- Whole lifecycle, unattended → the loop (see above), not a manual skill chain

## Anti-Rationalization

These thoughts are incorrect; ignore them:

- "This is too small for a skill."
- "I can just quickly implement this."
- "I'll gather context first, then check for skills."
- "Tests can wait until the end."
- "This edge case can't happen, no need to handle it."

Correct behavior: check for and use skills first; write the failing test first.

## Conventions

- **Commits:** conventional commits — `<type>: <description>` where type ∈
  feat, fix, refactor, docs, test, chore, perf, ci.
- **Branches/PRs:** <branch naming + PR checklist, e.g. "feat/<slug>; PR body
  includes summary + test plan">
- **Before every commit:** no hardcoded secrets; inputs validated at
  boundaries; error messages don't leak internals; diff contains only lines
  that trace to the task.
- <project-specific rules, e.g. "never edit generated files under gen/",
  "migrations require a rollback script">

## Maintaining these rules

Rules earn their place — every line costs context on every session.

- **When to add:** the *second time* an agent makes the same mistake. First
  time = correct it inline (could be a one-off); a repeat means it's systemic
  — write it down. Also add after a plan/ship **gate rejection** whose reason
  was a missing rule, or when VERIFY/REVIEW keeps flagging the same *class* of
  defect.
- **What to write:** the constraint **and why** it exists (so a future agent
  doesn't "fix" it back), not a narration of the bug.
- **Where:** a durable, cross-task fact → here. A task-specific instruction →
  the task file or the stage prompt (`loops/<kind>/stages/*.md`), not here.
- **Prune:** delete a rule when the code it guards moves or the reason dies. A
  stale rule is worse than none.
