# AGENTS.md

Guidance for AI coding agents working in this repository.

## Repository Overview

`agentic-loop` is a multi-kind agentic-loop framework (shared engine in
`@agentic-loop/core`, shipping both an OpenCode and a Claude Code plugin); this
guide covers the OpenCode plugin. It provides:

1. **The automatic agentic loop** (`/agent-loop`) — a real plugin
   (`src/index.ts` → `src/loop/`, agents/commands under `.opencode/`) that
   drives the whole lifecycle from one command: `/agent-loop new` interviews you
   into a planless draft task (`new <idea>` — always), `retask <id>` reshapes
   a draft in place, `approve <id>` queues it, and `approve [id]` /
   `replan <id>` are the plan gate;
   `/agent-loop` claims work (`task <id>`, or a `watch [interval]` worker
   session polling on idle events plus a timer), plans a queued task right
   before execution (PLAN parks the plan in `plan-review/` for your gate and
   exits), and drives BUILD→VERIFY→REVIEW unattended on plan-approved
   tasks. Use this
   when a goal should run the whole lifecycle largely unattended. See the
   `loop-orchestration` skill for the pipeline, gates, and verdict contracts,
   and `task-backlog-management` for driving it from
   `docs/tasks/`.
   That pipeline is the **engineering loop kind** — the default of several
   declarative kinds under `loops/<kind>/` (manifest + stage prompts) run by
   the shared `@agentic-loop/core` engine. Other kinds are enabled via
   `loops.<kind>` in `.agentic-loop.json`; `pr-sitter` (agents
   `loop-pr-triage` / `loop-pr-fix` / `loop-pr-publish`, plus
   the shared `loop-verify`) sits on open PRs — triages, fixes, verifies, and pushes
   replies, but never merges. `/agent-loop watch` and claims poll all
   enabled kinds, engineering backlog first.
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
- Run the whole lifecycle on a goal, largely unattended → `/agent-loop new <idea>` then `/agent-loop approve <id>` then `/agent-loop task <id>` (plans + parks) then `/agent-loop approve <id>` then `/agent-loop task <id>` (builds) — at the plan/ship gates `/agent-loop approve` (or `/agent-loop reject` to bounce a plan) is the one-word shortcut (draft approval stays `/agent-loop approve <id>`); see `loop-orchestration`, not a manual skill chain

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

- `src/index.ts`, `src/loop/`, `src/config.ts` — plugin implementation (state machine, driver); task backlog IO lives in `packages/core/src/task/`
- `packages/core/` — the shared `@agentic-loop/core` engine (manifest interpreter, scheduler, work sources) used by both the OpenCode plugin and the Claude MCP server
- `loops/<kind>/` — declarative loop-kind manifests (`loop.json`) + stage prompt templates (`engineering/`, `pr-sitter/`)
- `.opencode/agents/` — the agent personas backing each loop stage (engineering `loop-*` plus `loop-pr-triage`/`loop-pr-fix`/`loop-pr-publish`)
- `.opencode/commands/` — the slash commands (`/agent-loop`, `/plan`, `/plan-task`, `/build`, `/verify`, `/review`, and the pr-sitter stage commands `/pr-triage`, `/pr-fix`, `/pr-publish`)
- `.opencode/skills` — symlink to `skills/`, the skill library the stage agents invoke
- `skills/` — skill workflows (`SKILL.md` per directory) invoked by name via the `skill` tool
- `references/` — supplementary checklists (`testing-patterns.md`, `security-checklist.md`, etc.) that skills pull in when needed

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
