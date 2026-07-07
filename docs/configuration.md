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
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI), `"ado"` (Azure DevOps via the `az` CLI), or `"ado-mcp"` (Azure DevOps via the Microsoft ADO MCP server, for environments that forbid `az`). Overridable per kind with `loops.<kind>.codePlatform`. See below. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`); **required** when any effective platform is `"ado"` or `"ado-mcp"` — the config fails fast without it. `selfLogin` is additionally **required** for `"ado-mcp"`. |
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
