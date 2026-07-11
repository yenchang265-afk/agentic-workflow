# Configuration (`.agentic-loop.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

`./install.sh` seeds this file for you: on an interactive terminal it runs a
short wizard (code platform, PR sitter, worktrees, plus an advanced gate for the
tracker, review lenses, and iteration cap) and writes a valid `.agentic-loop.json`
into the project the loop will drive — the same directory the plugin reads config
from at runtime (`$AGENTIC_LOOP_DIR`, else the current directory), which it
prompts for. It never overwrites an existing file and is skipped under piped/CI
runs. Flags: `--no-config` skips it, `--config` forces it on, `-y`/`--yes` writes
an all-defaults file without prompting. Everything below can also be hand-edited
afterward.

| Field | Default | What it does |
|-------|---------|--------------|
| `maxIterations` | `3` | Max loop iterations before stopping on repeated check-stage failures (engineering: VERIFY/REVIEW; a manifest may override per kind). When the engineering cap trips, the plan is suspect — send it back with `/agentic-loop:engineering replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. Also hosts the ephemeral `runs/` machine state (snapshots, stage marker, PR-sitter ledgers). |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agentic-loop:engineering watch`; overridable per session via `/agentic-loop:engineering watch <interval>`. **OpenCode-only** — this field is an extension the OpenCode plugin adds in `src/config.ts` on top of the shared core schema (`packages/core/src/config.ts`); the Claude Code plugin has no watch timer. |
| `loops` | `{}` | Per-loop-kind sections — see below. |
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI) or `"ado"` (Azure DevOps via its REST API, PAT auth). Overridable per kind with `loops.<kind>.codePlatform`. See below. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`); **required** when any effective platform is `"ado"` — the config fails fast without it. `selfLogin` is **required** for `"ado"` (a PAT can't resolve the sitter's identity). |
| `projectManagement` | unset | The team's task tracker (Jira / Azure DevOps) and how local tasks pair to it. Drives task-authoring defaults and the pairing view in `/agentic-loop:engineering status`. See below. |
| `worktreesDir` | unset | See hardening below. |
| `worktreeSetup` | unset | Shell command run inside a freshly created worktree (e.g. `"npm ci"`). |
| `reviewLenses` | `[]` | See hardening below. Max 5 lenses. |

Both plugins read the same file: the schema lives in the shared core package
(`packages/core/src/config.ts`), and each host may extend it with fields only
it can honor (today: OpenCode's `watchIntervalMinutes` — see
[`plugins/claude/README.md`](../plugins/claude/README.md)).

## Loop kinds (`loops`)

Each key under `loops` enables and configures one loop kind (a
`packages/core/loops/<kind>/` manifest). **`engineering` runs unless explicitly disabled**;
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
- **`loops.pr-sitter.enabled`** — default off; requires authenticated access
  to the platform: `gh` (GitHub), or a PAT in `AZURE_DEVOPS_EXT_PAT` (ADO).
- **`loops.pr-sitter.query`** — overrides the manifest's
  `gh pr list --search` query (default `is:open author:@me`) selecting which
  PRs the sitter watches. GitHub only — on ADO the sitter watches active PRs
  authored by its own identity.
- **`loops.<kind>.codePlatform`** — per-kind override of the global
  `codePlatform` (e.g. run the sitter against ADO while everything else
  defaults to GitHub).

## Code platform (`codePlatform` / `ado`)

The PR sitter binds to a hosted-PR work source (`workSource.type:
"github-pr"` in its manifest); which platform that source actually talks to
is resolved from config at wiring time — the manifest is never forked.

```json
{
  "codePlatform": "ado",
  "ado": {
    "organization": "https://dev.azure.com/acme",
    "project": "widgets",
    "repository": "widgets-api",
    "selfLogin": "sitter@acme.com"
  },
  "loops": { "pr-sitter": { "enabled": true } }
}
```

- **`ado.organization` / `ado.project`** — required ADO coordinates.
- **`ado.repository`** — optional; omitted → all active PRs across the project.
- **`ado.selfLogin`** — **required**; the sitter's own login for filtering its
  own PR comments. A PAT can't resolve the sitter's identity — without it every
  comment (including the sitter's own replies) re-triggers attention.
- **`ado.pat`** — optional; the PAT in plaintext, as a fallback for when the
  `AZURE_DEVOPS_EXT_PAT` env var is unset. **The env var wins** when both are
  set. Prefer the env var; if you use `ado.pat`, keep `.agentic-loop.json`
  gitignored (it is by default) so the secret is never committed. It reaches
  every consumer: the work source reads it directly, and the triage/publish
  stage agents (which authenticate via `$AZURE_DEVOPS_EXT_PAT`) get it exported
  for them — on OpenCode at plugin init (`applyAdoPatEnv`), on Claude Code via a
  `SessionStart` hook (`inject-ado-pat.mjs`) that writes it to `$CLAUDE_ENV_FILE`.
  Neither ever overrides a PAT you exported yourself.
- **Prerequisites for `"ado"`**: a Personal Access Token — in
  `AZURE_DEVOPS_EXT_PAT` (preferred) or `ado.pat` — scoped to Code (read) +
  Pull Request contribute (comment), and `curl`. The token is sent as HTTP Basic
  auth (`curl -sS -u :"$AZURE_DEVOPS_EXT_PAT" <url>`); no `az` CLI is needed.
- **Semantics on ADO**: failing checks come from blocking branch policy
  evaluations (`_apis/policy/evaluations`) — a repo with no build policy never
  fires `failing-checks`; comments come from PR threads; a negative reviewer
  vote maps to changes-requested; `mergeStatus: conflicts` maps to
  merge-conflict.
- Stage bash allowlists are platform-scoped: the manifest's
  `platformAllowlist.github` / `.ado` globs are merged into the stage's
  `bashAllowlist` for the resolved platform. The OpenCode agent frontmatter
  (static YAML) carries both platforms' CLI allowlists as a deliberate
  breadth tradeoff — the loop.json/stage-marker path stays platform-narrow.

See [`loops/README.md`](../packages/core/loops/README.md) for authoring new kinds and
[`docs/design/threat-model.md`](design/threat-model.md) for the PR sitter's
security posture before enabling it.

## Project management (`projectManagement`)

Points the loop at the team's task tracker so **local backlog tasks pair to
tracker items** (Jira issues / Azure DevOps work items). The task frontmatter
already carries an optional `tracker` block (see the
[`task-backlog-management`](../skills/task-backlog-management/SKILL.md) schema);
this config supplies the authoring defaults and turns pairing into a first-class
part of the loop. Pairing is **manual** — the loop never calls the tracker's
API; a human copies the issue key/id into the task.

```json
{
  "projectManagement": {
    "system": "jira",
    "baseUrl": "https://acme.atlassian.net/browse/",
    "defaultType": "story"
  }
}
```

- **`system`** (required) — `"jira"` or `"azure-devops"`. Becomes the default
  `tracker.system` stamped on tasks authored via `/agentic-loop:engineering new`.
- **`baseUrl`** — optional URL prefix a task's `tracker.key` is appended to,
  to build a deep link (Jira: `…/browse/`; ADO: `…/_workitems/edit/`). Unset →
  no link is built.
- **`defaultType`** — optional issue/work-item type stamped on new drafts
  (e.g. `story`, `task`, `bug`).

Pairing is always **optional** — a task never has to carry a `tracker` block;
this section only supplies authoring defaults and the status view.

Impact on the commands:

- **`/agentic-loop:engineering new`** pre-fills `tracker.system` (and `type` from
  `defaultType`) so the drafted task is ready to pair — you fill in the
  `tracker.key`.
- **`/agentic-loop:engineering status`** adds a `pairing` roll-up: the tracker system, how
  many active tasks are paired, and the ids of those still unpaired.

## Optional hardening

- **`worktreesDir`** — run each loop in its own `git worktree` instead of
  switching branches in the shared checkout. The human's tree is never
  touched and multiple `/agentic-loop:engineering watch` sessions can build concurrently in one
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

## Environment (Claude Code MCP host)

The Claude Code MCP server reads two directory pointers from the environment.
Neither applies to the OpenCode host, which takes its directory from the
project you opened.

- **`AGENTIC_LOOP_DIR`** — the canonical repo root the server operates on:
  where the task backlog lives, where per-task worktrees are created under
  `worktreesDir`, and where run logs are written. Defaults to the server's
  working directory at launch. Set it when Claude Code roots the server
  somewhere other than the repo you mean.
- **`AGENTIC_LOOP_BASE_DIR`** — where the **base branch** for a new
  `feature/<id>` worktree is read from. Claude Code freezes `AGENTIC_LOOP_DIR`
  at the main checkout (usually the default branch), so without this every
  loop cuts from that branch. Point it at the tree you actually work in and
  the base is read there **live per claim** (`git rev-parse --abbrev-ref
  HEAD`), so `feature/<id>` branches off the branch you're on. Unset ⇒ the base
  falls back to whatever branch `AGENTIC_LOOP_DIR` has checked out (the prior
  behavior). A detached base dir is ignored (same fallback).

See `design/threat-model.md` for the security posture and
`design/improvements/` for the design record behind these features.
