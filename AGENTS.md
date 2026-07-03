# AGENTS.md

Guidance for AI coding agents working in this repository.

## Repository Overview

`agentic-loop` is an OpenCode plugin. It provides:

1. **The automatic agentic loop** (`/loop`) — a real plugin
   (`src/index.ts` → `src/loop/`, agents/commands under `.opencode/`) that
   drives the full DEFINE→PLAN→BUILD→VERIFY→REVIEW lifecycle across **two
   sessions**: DEFINE/PLAN plan interactively (with, for an underspecified
   free-text goal, a conditional `interview-me`-backed clarification before
   DEFINE) and park the approved plan as a task; a separate `/loop watch`
   session claims and builds it (BUILD→VERIFY→REVIEW). Use this when a goal
   should run the whole lifecycle largely unattended. See the
   `loop-orchestration` skill for the pipeline, gates, and verdict contracts,
   and `task-backlog-management` for driving it from
   `docs/tasks/`.
2. **Ad-hoc, skill-driven execution** — for a single request that doesn't
   warrant starting a loop, OpenCode still has a **skill-driven execution
   model** powered by the `skill` tool and the `skills/` directory bundled
   with this plugin. The rules below govern that mode.

### Core Rules (ad-hoc mode)

- If a task matches a skill, you MUST invoke it
- Skills are located in `skills/<skill-name>/SKILL.md`
- Never implement directly if a skill applies
- Always follow the skill instructions exactly (do not partially apply them)

### Intent → Skill Mapping

- Feature / new functionality → `spec-driven-development`, then `incremental-implementation`, `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or interface design → `api-and-interface-design`
- UI work → `frontend-ui-engineering`
- Run the whole lifecycle on a goal, largely unattended → `/loop <goal>` (see `loop-orchestration`), not a manual skill chain

### Lifecycle Mapping

`/loop` implements this lifecycle as real pipeline stages (see
`loop-orchestration`). Outside the loop, follow it as an implicit sequence of
skill invocations instead:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`

### Execution Model (ad-hoc mode)

For every request that isn't handed to `/loop`:

1. Determine if any skill applies (even 1% chance)
2. Invoke the appropriate skill using the `skill` tool
3. Follow the skill workflow strictly
4. Only proceed to implementation after required steps (spec, plan, etc.) are complete

### Anti-Rationalization

The following thoughts are incorrect and must be ignored:

- "This is too small for a skill"
- "I can just quickly implement this"
- "I'll gather context first"

Correct behavior: always check for and use skills first.

## Plugin Structure

- `src/index.ts`, `src/loop/`, `src/task/`, `src/config.ts` — plugin implementation (state machine, driver, task backlog IO)
- `.opencode/agents/` — the agent personas backing each `/loop` stage
- `.opencode/commands/` — the slash commands (`/loop`, `/define`, `/plan`, `/build`, `/verify`, `/review`, `/task`)
- `.opencode/skills` — symlink to `skills/`, the skill library the stage agents invoke
- `skills/` — skill workflows (`SKILL.md` per directory) invoked by name via the `skill` tool
- `references/` — supplementary checklists (`testing-patterns.md`, `security-checklist.md`, etc.) that skills pull in when needed
