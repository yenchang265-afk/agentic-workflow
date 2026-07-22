English | [繁體中文](CLAUDE.zh-TW.md)

# AGENTS.md — <project name>

<!--
  Starter AGENTS.md for projects driven by the agentic-workflow plugin.

  How to use:
  1. Copy this file to your repo root as `AGENTS.md` (OpenCode) or `CLAUDE.md`
     (Claude Code). Want both? Copy it twice, don't symlink — symlinks don't
     survive every checkout path (zip export, some CI artifact steps).
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

## Loop vs Ad-hoc

Two execution modes. Pick by scope, not habit.

**Use the agentic loop** when a goal is multi-step and should run largely
unattended (a feature, a refactor with tests, anything worth a task file):

1. `/agentic-workflow:engineering new <idea>` — interview produces a draft task with the
   goal and testable acceptance criteria (always from you, never guessed)
2. Review the draft, then `/agentic-workflow:engineering approve <id>` — queues it
3. `/agentic-workflow:engineering plan <id>` claims the queued task,
   writes the `## Implementation Plan` right before execution, and parks it
   at the plan gate (`claim`/`watch` never auto-plan a queued task)
4. `/agentic-workflow:engineering approve <id>` (or `replan <id> [why]`) — after
   approval a `claim`/`watch` worker runs BUILD→VERIFY→REVIEW unattended on a
   `feature/<id>` branch; you review the result and
   `/agentic-workflow:engineering approve <id>` ships it

`approve` is the same verb at every gate — the folder the task sits in picks
the move, so it is never ambiguous. Id-less **`/agentic-workflow:engineering approve`** advances
the one task waiting at a loop gate (a parked plan or a finished review —
falling back to a lone draft when neither waits; pass the id when more than
one waits), and
**`/agentic-workflow:engineering replan`** bounces a parked plan back.

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
  the task file or the stage prompt (`workflows/<kind>/stages/*.md`), not here.
- **Prune:** delete a rule when the code it guards moves or the reason dies. A
  stale rule is worse than none.
