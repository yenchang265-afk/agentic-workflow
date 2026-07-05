# AGENTS.md

Guidance for AI coding agents working in this repository.

## Repository Overview

`agentic-loop` is an OpenCode plugin. It provides:

1. **The automatic agentic loop** (`/agent-loop-task` + `/agent-loop`) — a real plugin
   (`src/index.ts` → `src/loop/`, agents/commands under `.opencode/`) that
   splits the lifecycle into two commands: `/agent-loop-task` interviews you
   into a planless draft task (`new <idea>` — always), `approve <id>` queues
   it, and `approve-plan <id>` / `replan <id>` are the plan gate;
   `/agent-loop` claims work (`task <id>`, or a `watch [interval]` worker
   session polling on idle events plus a timer), plans a queued task right
   before execution (PLAN parks the plan in `plan-review/` for your gate and
   exits), and drives BUILD→VERIFY→REVIEW unattended on plan-approved
   tasks. Use this
   when a goal should run the whole lifecycle largely unattended. See the
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
- Run the whole lifecycle on a goal, largely unattended → `/agent-loop-task new <idea>` then `/agent-loop-task approve <id>` then `/agent-loop task <id>` (plans + parks) then `/agent-loop-task approve-plan <id>` then `/agent-loop task <id>` (builds) — see `loop-orchestration`, not a manual skill chain

### Lifecycle Mapping

`/agent-loop` implements this lifecycle as real pipeline stages (see
`loop-orchestration`). Outside the loop, follow it as an implicit sequence of
skill invocations instead:

- PLAN → `spec-driven-development` + `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`

### Execution Model (ad-hoc mode)

For every request that isn't handed to `/agent-loop`:

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
- `.opencode/agents/` — the agent personas backing each `/agent-loop` stage
- `.opencode/commands/` — the slash commands (`/agent-loop`, `/agent-loop-task`, `/plan`, `/plan-task`, `/build`, `/verify`, `/review`, `/explore`)
- `.opencode/skills` — symlink to `skills/`, the skill library the stage agents invoke
- `skills/` — skill workflows (`SKILL.md` per directory) invoked by name via the `skill` tool
- `references/` — supplementary checklists (`testing-patterns.md`, `security-checklist.md`, etc.) that skills pull in when needed
