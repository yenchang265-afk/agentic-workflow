# agentic-loop

An [opencode](https://opencode.ai) plugin that transforms an engineer's workflow into an agentic loop:

```
plan → build → verify   (repeat)
```

A single `/loop <goal>` drives the whole pipeline: it runs plan, **pauses for a
human to approve the plan** before any code is written, then runs build → verify,
finishing on a verify pass or after an iteration cap.

## Workflow stages

Each stage ships a command, a subagent, and a skill (under `.opencode/`).

| Stage | Command | Writes code? | What it does |
|-------|---------|--------------|--------------|
| **plan** | `/plan <goal>` | no | Read the relevant code, then turn the goal into an ordered, review-sized plan with **testable acceptance criteria**. |
| **build** | `/build <goal+plan>` | **yes** | Implement the approved plan test-first with surgical diffs. The only writing stage. |
| **verify** | `/verify <goal+criteria>` | no | Run tests, check acceptance criteria, emit a `LOOP_VERIFY: PASS`/`FAIL` verdict. |

Each command also works standalone, outside the loop.

## Repo improvement scan

`/explore [path]` is a **standalone** command, independent of the loop — it
scans the repo (or a target path) for improvement opportunities not tied to
any active goal: refactors, dead code, tech debt, stale docs. Each surviving
finding (deduped against existing tasks, capped at ~5 per run) becomes one
draft task in `docs/tasks/draft/` for you to review and, if you want it done,
move to `docs/tasks/in-progress/`.

## The loop

| Command | Effect |
|---------|--------|
| `/loop <goal>` | Start a loop: runs plan, then pauses at the plan gate. |
| `/loop next` | Run the highest-priority *unplanned* task from `docs/tasks/in-progress/`. |
| `/loop task <id>` | Run a specific in-progress task by id; resumes the approval gate if it's already planned. |
| `/loop go` | Approve the plan and run build → verify. |
| `/loop stop` | Abort and clear loop state. |
| `/loop status` | Show current stage, iteration, and pause state. |

```
/loop <goal> ─▶ plan ─GATE(/loop go)─▶ build ─auto─▶ verify
                  ▲                                     │
                  └──────── FAIL (re-plan) ─────────────┤
                                                          ▼
                                              PASS → done (review diff, open PR)
```

**How it advances.** The plugin (`src/index.ts` → `src/loop/`) reacts to `session.idle`,
fires each stage via `client.session.command`, captures its output, and feeds it into the pure
state machine in `src/loop/state.ts` to decide the next step. Stage context is threaded through
the command arguments, so each stage stays a clean subtask.

**Termination.** Verify PASS finishes the loop; a verify FAIL re-plans with the failure feedback
until `maxIterations` (default 3) is reached. The verify-pass hand-off is the final human gate —
you review the diff and open the PR yourself.

## Task backlog

Drive the loop from a filesystem backlog instead of a typed goal. A task is one
markdown file under `docs/tasks/`; **the folder it lives in is its status**
(`draft → in-progress → completed`, plus `abandoned`). You move a task into
`in-progress/`; `/loop next` picks the highest-priority task that isn't already
planned and runs it. The first time its plan gates for approval, the plan is
appended to the task file (`## Implementation Plan`) so `/loop next` won't
re-plan it and `/loop task <id>` can resume the approval later, even after a
stopped/restarted session. The driver moves the file to `completed/` on a
verify PASS; on failure it stays in `in-progress/` with a note. Write task
files by hand, run `/task new <idea>` to have a subagent draft a schema-valid
one into `draft/`, or run `/explore` to have the repo scanned for improvement
candidates and filed there automatically. See
[`docs/tasks/README.md`](docs/tasks/README.md) for the file schema and lifecycle.

### Config

Optional `.agentic-loop.json` at the repo root (sane defaults if absent):

```jsonc
{
  "maxIterations": 3,         // stop after this many failed verify iterations
  "gateBeforeBuild": true,    // pause for human plan approval before build edits anything
  "tasksDir": "docs/tasks"    // root of the task backlog (folders are statuses)
}
```

### Limitations

- Loop state is in-memory — it does not survive an opencode restart (the task
  files on disk are the durable record).
- Per-task git branch/worktree, PR-size gating, and an Azure DevOps task source
  are deferred (see git history).

## Install

Add the runtime plugin to your `opencode.json`:

```json
{
  "plugin": ["agentic-loop"]
}
```

The stage commands/agents/skills load from `.opencode/` when the repo is checked out in your
project (or copy them into your own `.opencode/`).

## Develop

```bash
npm install        # install plugin types, tsx, and typescript
npm run typecheck  # tsc --noEmit
npm test           # node --test via tsx (pure loop logic)
```

The runtime entry point is `src/index.ts`, exporting the `AgenticLoop` plugin. The pure loop
state machine lives in `src/loop/state.ts`; the impure orchestration (firing stages, gates) in
`src/loop/driver.ts`.

## License

[Apache-2.0](./LICENSE)
