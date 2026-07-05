# Configuration (`.agentic-loop.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

| Field | Default | What it does |
|-------|---------|--------------|
| `maxIterations` | `3` | Max loop iterations before stopping on repeated VERIFY/REVIEW failures. When the cap trips, the plan is suspect — send it back with `/agent-loop-task replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agent-loop watch` (OpenCode only); overridable per session via `/agent-loop watch <interval>`. |
| `worktreesDir` | unset | See hardening below. |
| `worktreeSetup` | unset | Shell command run inside a freshly created worktree (e.g. `"npm ci"`). |
| `reviewLenses` | `[]` | See hardening below. Max 5 lenses. |

The Claude Code plugin reads the same file with the same schema **minus**
`watchIntervalMinutes` (it has no watch mode — see
[`claude-plugin/README.md`](../claude-plugin/README.md)).

## Optional hardening

- **`worktreesDir`** — run each loop in its own `git worktree` instead of
  switching branches in the shared checkout. The human's tree is never
  touched and multiple `/agent-loop watch` sessions can build concurrently in one
  instance. Off by default (a fresh worktree has no installed deps — pair it
  with `worktreeSetup`, e.g. `"npm ci"`). Audit notes and task moves stay in
  the main tree and are committed there per terminal event.
- **`reviewLenses`** — run REVIEW once per lens (e.g.
  `["correctness", "security", "test-adequacy"]`) and take the worst verdict,
  so a single prompt-injected reviewer can't wave a change through. Costs ~N×
  review time; off by default.
- Secrets echoed into audit notes, plans, or run logs are **shape-redacted**
  (`AKIA…`, `sk-…`, tokens, PEM blocks, `key/secret/token: …` assignments)
  before they are written and committed.
- On a terminal event the run log gets a **`## Run summary`** table — per-stage
  wall-clock, verdict history, and iterations used.

See `design/threat-model.md` for the security posture and
`design/improvements/` for the design record behind these features.
