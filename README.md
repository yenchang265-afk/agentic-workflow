# agentic-loop

An [opencode](https://opencode.ai) plugin that transforms an engineer's workflow into an agentic loop:

```
explore → plan → build → verify   (repeat)
```

A single `/loop <goal>` drives the whole pipeline: it runs explore → plan automatically,
**pauses for a human to approve the plan** before any code is written, then runs build → verify,
finishing on a verify pass or after an iteration cap.

## Workflow stages

Each stage ships a command, a subagent, and a skill (under `.opencode/`).

| Stage | Command | Writes code? | What it does |
|-------|---------|--------------|--------------|
| **explore** | `/explore <target>` | no | Map relevant code, trace call paths, surface reusable patterns — understanding only. |
| **plan** | `/plan <goal>` | no | Turn findings into an ordered, review-sized plan with **testable acceptance criteria**. |
| **build** | `/build <goal+plan>` | **yes** | Implement the approved plan test-first with surgical diffs. The only writing stage. |
| **verify** | `/verify <goal+criteria>` | no | Run tests, check acceptance criteria, emit a `LOOP_VERIFY: PASS`/`FAIL` verdict. |

Each command also works standalone, outside the loop.

## The loop

| Command | Effect |
|---------|--------|
| `/loop <goal>` | Start a loop: runs explore → plan, then pauses at the plan gate. |
| `/loop go` | Approve the plan and run build → verify. |
| `/loop stop` | Abort and clear loop state. |
| `/loop status` | Show current stage, iteration, and pause state. |

```
/loop <goal> ─▶ explore ─auto─▶ plan ─GATE(/loop go)─▶ build ─auto─▶ verify
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

### Config

Optional `.agentic-loop.json` at the repo root (sane defaults if absent):

```jsonc
{
  "maxIterations": 3,      // stop after this many failed verify iterations
  "gateBeforeBuild": true  // pause for human plan approval before build edits anything
}
```

### Limitations

- Loop state is in-memory — it does not survive an opencode restart.
- Task ingestion (Azure DevOps / `/docs`) and PR-size gating are deferred (see git history).

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
