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
| `maxIterations` | `3` | Max loop iterations before stopping on repeated check-stage failures (engineering: VERIFY/REVIEW; a manifest may override per kind). When the engineering cap trips, the plan is suspect — send it back with `/agent-loop-task replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. Also hosts the ephemeral `runs/` machine state (snapshots, stage marker, PR-sitter ledgers). |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agent-loop watch`; overridable per session via `/agent-loop watch <interval>`. **OpenCode-only** — this field is an extension the OpenCode plugin adds in `src/config.ts` on top of the shared core schema (`packages/core/src/config.ts`); the Claude Code plugin has no watch timer. |
| `loops` | `{}` | Per-loop-kind sections — see below. |
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI), `"ado"` (Azure DevOps via the `az` CLI), or `"ado-mcp"` (Azure DevOps via the Microsoft ADO MCP server, for environments that forbid `az`). Overridable per kind with `loops.<kind>.codePlatform`. See below. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`); **required** when any effective platform is `"ado"` or `"ado-mcp"` — the config fails fast without it. `selfLogin` is additionally **required** for `"ado-mcp"`. |
| `projectManagement` | unset | The team's task tracker (Jira / Azure DevOps) and how local tasks pair to it. Drives task-authoring defaults and the pairing view in `/agent-loop status`. See below. |
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
- **`loops.pr-sitter.enabled`** — default off; requires an authenticated
  platform CLI (`gh`, or `az` when the platform is `ado`).
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
- **`ado.repository`** — optional; omitted → the az CLI's configured default.
- **`ado.selfLogin`** — optional; the sitter's own login for filtering its own
  PR comments. Needed under PAT-only auth, where `az ad signed-in-user` /
  `az account show` can't resolve an identity — without it every comment
  (including the sitter's own replies) re-triggers attention.
- **Prerequisites for `"ado"`**: `az` CLI with the `azure-devops` extension
  (`az extension add --name azure-devops`), authenticated via `az devops login`
  or `AZURE_DEVOPS_EXT_PAT`. Auth is delegated to the CLI, exactly like `gh`.
- **Semantics on ADO**: failing checks come from blocking branch policies
  (`az repos pr policy list`) — a repo with no build policy never fires
  `failing-checks`; comments come from PR threads; a negative reviewer vote
  maps to changes-requested; `mergeStatus: conflicts` maps to merge-conflict.
- Stage bash allowlists are platform-scoped: the manifest's
  `platformAllowlist.github` / `.ado` globs are merged into the stage's
  `bashAllowlist` for the resolved platform. The OpenCode agent frontmatter
  (static YAML) carries both platforms' CLI allowlists as a deliberate
  breadth tradeoff — the loop.json/stage-marker path stays platform-narrow.

### Azure DevOps without the `az` CLI (`codePlatform: "ado-mcp"`)

Some environments forbid the `az` CLI and allow Azure DevOps access only
through the **Microsoft Azure DevOps MCP server** (`microsoft/azure-devops-mcp`),
where every ADO call is an MCP tool invoked inside an agent session. Set
`codePlatform: "ado-mcp"` for that. It reuses the same `ado` section:

```json
{
  "codePlatform": "ado-mcp",
  "ado": {
    "organization": "https://dev.azure.com/acme",
    "project": "widgets",
    "selfLogin": "sitter@acme.com"
  },
  "loops": { "pr-sitter": { "enabled": true } }
}
```

- **`ado.selfLogin` is required** in this mode — the MCP server has no reliable
  whoami tool, so the sitter's own login must be configured to find its own PRs
  and filter its own comments. Config validation fails fast without it.
- **Register the MCP server under the name `ado`** in your own MCP config so its
  tools surface as `mcp__ado__<tool>` — the stage prompts and agent tool
  allowlists reference that exact name. This is a hard requirement (static agent
  frontmatter can't be templated per config). For example, in a Claude Code
  project `.mcp.json`:

  ```json
  { "mcpServers": { "ado": { "command": "npx", "args": ["-y", "@azure-devops/mcp", "acme"] } } }
  ```

  For OpenCode, register the same server under `ado` in `opencode.json`. Auth is
  the MCP server's own (Entra / `az login` session / PAT), never handled here.
- **How polling works**: the sitter's polling loop runs outside any agent
  session and so can't call MCP tools. Instead it emits a data request that a
  read-only poll agent (`loop-pr-poll`) fulfills via the `ado` MCP tools, handing
  a JSON bundle back. On Claude Code, `loop_claim` returns `needsAdoData` and the
  main agent spawns `loop-pr-poll`, then re-calls `loop_claim` with the bundle.
- **Semantics on `ado-mcp`**: changes-requested (negative reviewer vote),
  merge-conflict (`mergeStatus: conflicts`), and new-comments (PR threads) are
  the same as `ado`. **failing-checks differ**: the MCP server has no
  branch-policy tool, so a failing check is approximated from **failed builds**
  on the PR's source branch (`pipelines_get_builds`) rather than blocking branch
  policies. A repo whose gating is policy-only (no build) may not fire
  `failing-checks` in this mode.
- **Write containment**: the sitter only reads PRs and posts thread replies. On
  Claude Code the stage agents' `tools:` lists exclude every PR-mutating MCP tool
  (a subagent cannot call a tool absent from its list), and a PreToolUse hook
  blocks them outright as a backstop (`repo_update_pull_request`,
  `repo_vote_pull_request`, `repo_update_pull_request_reviewers`,
  `repo_create_pull_request`, `pipelines_run_pipeline`). On OpenCode the same
  tools are denied per-agent in frontmatter; because OpenCode's per-agent MCP
  gating is the operator's responsibility and its tool naming can vary, **also
  scope the `ado` MCP server's PAT to read + contribute-to-PR (comment)** as the
  hard containment — the equivalent of scoping `AZURE_DEVOPS_EXT_PAT` for the
  `az` path.

See [`loops/README.md`](../loops/README.md) for authoring new kinds and
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
  `tracker.system` stamped on tasks authored via `/agent-loop-task new`.
- **`baseUrl`** — optional URL prefix a task's `tracker.key` is appended to,
  to build a deep link (Jira: `…/browse/`; ADO: `…/_workitems/edit/`). Unset →
  no link is built.
- **`defaultType`** — optional issue/work-item type stamped on new drafts
  (e.g. `story`, `task`, `bug`).

Pairing is always **optional** — a task never has to carry a `tracker` block;
this section only supplies authoring defaults and the status view.

Impact on the commands:

- **`/agent-loop-task new`** pre-fills `tracker.system` (and `type` from
  `defaultType`) so the drafted task is ready to pair — you fill in the
  `tracker.key`.
- **`/agent-loop status`** adds a `pairing` roll-up: the tracker system, how
  many active tasks are paired, and the ids of those still unpaired.

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
  `loop/<id>` worktree is read from. Claude Code freezes `AGENTIC_LOOP_DIR`
  at the main checkout (usually the default branch), so without this every
  loop cuts from that branch. Point it at the tree you actually work in and
  the base is read there **live per claim** (`git rev-parse --abbrev-ref
  HEAD`), so `loop/<id>` branches off the branch you're on. Unset ⇒ the base
  falls back to whatever branch `AGENTIC_LOOP_DIR` has checked out (the prior
  behavior). A detached base dir is ignored (same fallback).

See `design/threat-model.md` for the security posture and
`design/improvements/` for the design record behind these features.
