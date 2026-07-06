# Configuration (`.agentic-loop.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

| Field | Default | What it does |
|-------|---------|--------------|
| `maxIterations` | `3` | Max loop iterations before stopping on repeated check-stage failures (engineering: VERIFY/REVIEW; a manifest may override per kind). When the engineering cap trips, the plan is suspect — send it back with `/agent-loop-task replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. Also hosts the ephemeral `runs/` machine state (snapshots, stage marker, PR-sitter ledgers). |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agent-loop watch`; overridable per session via `/agent-loop watch <interval>`. **OpenCode-only** — this field is an extension the OpenCode plugin adds on top of the shared core schema (`src/config.ts`); the Claude Code plugin has no watch timer. |
| `loops` | `{}` | Per-loop-kind sections — see below. |
| `worktreesDir` | unset | See hardening below. |
| `worktreeSetup` | unset | Shell command run inside a freshly created worktree (e.g. `"npm ci"`). |
| `reviewLenses` | `[]` | See hardening below. Max 5 lenses. |

Both plugins read the same file: the schema lives in the shared core package
(`packages/core/src/config.ts`), and each host may extend it with fields only
it can honor (today: OpenCode's `watchIntervalMinutes` — see
[`claude-plugin/README.md`](../claude-plugin/README.md)).

## Loop kinds (`loops`)

Each key under `loops` enables and configures one loop kind (a
`loops/<kind>/` manifest). **`engineering` runs unless explicitly disabled**;
every other kind is opt-in with `"enabled": true`. Kind-specific knobs ride
along in the same section and are validated by the kind itself. Enabled kinds
are polled in claim-priority order: engineering first, then opted-in kinds in
config order.

```json
{
  "loops": {
    "engineering": { "enabled": true },
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    }
  }
}
```

- **`loops.engineering.enabled`** — default `true`; set `false` to run only
  other kinds (e.g. a dedicated PR-sitter watcher).
- **`loops.pr-sitter.enabled`** — default off; requires an authenticated `gh`.
- **`loops.pr-sitter.query`** — overrides the manifest's
  `gh pr list --search` query (default `is:open author:@me`) selecting which
  PRs the sitter watches.

See [`loops/README.md`](../loops/README.md) for authoring new kinds and
[`docs/design/threat-model.md`](design/threat-model.md) for the PR sitter's
security posture before enabling it.

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
