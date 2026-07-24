English | [繁體中文](configuration.zh-TW.md)

# Configuration (`.agentic-workflow.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

## Quick-start templates

Copy the block for your platform into `.agentic-workflow.json`, replace the
placeholders, done — everything else keeps its default. The rest of this
page is the field-by-field reference; you shouldn't need it for a first setup.

**GitHub** (the default platform — this file is equivalent to having no
`.agentic-workflow.json` at all, plus `pr-sitter` turned on):

```json
{
  "workflows": {
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" }
  }
}
```

Replace `query` with the PR search you want the sitter to watch, or delete
the whole `workflows` block if you only want the engineering loop (its default).

**Azure DevOps:**

```json
{
  "codePlatform": "ado",
  "ado": {
    "organization": "https://dev.azure.com/<your-org>",
    "project": "<your-project>",
    "selfLogin": "<your-login-or-service-account-email>"
  },
  "workflows": {
    "pr-sitter": { "enabled": true }
  }
}
```

Replace `<your-org>`, `<your-project>`, and `<your-login-or-service-account-email>`
— all three are required for `"ado"`. Add `"repository": "<your-repo>"` next
to `project` if you'll use the ship gate or the `dep-sitter`/`main-sitter`
publish stages (they need one specific repo to open a PR against). Don't put
your PAT in this file — export `AZURE_DEVOPS_EXT_PAT=<pat>` instead; see
[Code platform](#code-platform-codeplatform--ado) below for the fallback and
its tradeoffs.

## Layers & precedence

Config is resolved from two optional layers:

1. **User scope** — `~/.config/agentic-workflow/agentic-workflow.json` (honoring
   `$XDG_CONFIG_HOME`; the legacy `~/.agentic-workflow.json` is still read as a
   fallback when this file is absent), applied to every repo you run the
   loop in. Override the path with `AGENTIC_WORKFLOW_USER_CONFIG`; set it to `""`
   to disable the layer entirely (e.g. in CI).
2. **Repo scope** — `.agentic-workflow.json` at the repo root, which **overrides
   the user layer field by field**.

The merge is a field-level deep merge: nested objects (`ado`, `workflows`, each
`workflows.<kind>` section) merge per key recursively; arrays (`reviewLenses`) and
scalars replace wholesale. Layers merge *before* validation, so defaults never
clobber an explicit value from either file, and cross-field requirements (like
`codePlatform: "ado"` needing `ado.selfLogin`) are checked against the
combined view — the intended split being:

- **User scope**: identity and credentials shared across repos —
  `ado.organization`, `ado.selfLogin`, `ado.pat` — plus personal defaults such
  as `maxIterations`.
- **Repo scope**: everything tied to the project — `codePlatform`,
  `ado.project`, `ado.repository`, `tasksDir`, `workflows`, worktree settings.

Keep `codePlatform` and `workflows` in the repo file by convention: a user-scope
value silently applies to *every* repo. If the user file holds a PAT, protect
it (`chmod 600 ~/.config/agentic-workflow/agentic-workflow.json`); the `AZURE_DEVOPS_EXT_PAT` env var
still wins over both layers. On a mixed Windows/WSL setup note the two worlds
have different home directories — hosts running inside WSL resolve the WSL
home; point `AGENTIC_WORKFLOW_USER_CONFIG` at one file if you straddle both.

`./install.sh` seeds this file for you: on an interactive terminal it runs a
short wizard (code platform, sitters, worktrees, plus an advanced gate for the
tracker, review lenses, and iteration cap) and writes a valid `.agentic-workflow.json`.
Its first question is the **scope** — where to write:

- **repo scope** (default) — `<project>/.agentic-workflow.json` in the directory the
  plugin reads config from at runtime (`$AGENTIC_WORKFLOW_DIR`, else the current
  directory), which it prompts for. Per-project settings live here.
- **user scope** — the shared user-scope file (`$AGENTIC_WORKFLOW_USER_CONFIG`, else
  `~/.config/agentic-workflow/agentic-workflow.json`), read for every repo you drive. Settings shared across
  repos (the `ado` block, review lenses) belong here; a repo file overrides it
  field by field (see [Layers & precedence](#layers--precedence) above).

Force the scope non-interactively with `--user` or `--repo`. It never overwrites
an existing file and is skipped under piped/CI runs. Other flags: `--no-config`
skips it, `--config` forces it on, `-y`/`--yes` writes an all-defaults file
without prompting (honoring `--user`/`--repo`). Everything below can also be
hand-edited afterward.

| Field | Default | What it does |
|-------|---------|--------------|
| `maxIterations` | `3` | Max loop iterations before stopping on repeated check-stage failures (engineering: VERIFY/REVIEW; a manifest may override per kind). When the engineering cap trips, the plan is suspect — send it back with `/agentic-workflow:engineering replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. Also hosts the ephemeral `runs/` machine state (snapshots, stage marker, PR-sitter ledgers). |
| `ignoreBacklog` | `true` | See hardening below. Set to `false` to commit every task move as an audit trail (the old behavior). |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agentic-workflow:engineering watch`; overridable per session via `/agentic-workflow:engineering watch <interval>`. **OpenCode-only** — this field is an extension the OpenCode plugin adds in `src/config.ts` on top of the shared core schema (`packages/core/src/config.ts`); the Claude Code plugin has no watch timer. |
| `workflows` | `{}` | Per-workflow-kind sections — see below. |
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI) or `"ado"` (Azure DevOps — via its REST API + a PAT). Overridable per kind with `workflows.<kind>.codePlatform`. See below. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`, `customHeaders`, `insecureSkipTlsVerify`); **required** when any effective platform is `"ado"` — the config fails fast without it. `selfLogin` is **required** for `"ado"` (a PAT can't resolve the sitter's identity). |
| `projectManagement` | unset | The team's task tracker (Jira / Azure DevOps) and how local tasks pair to it. Drives task-authoring defaults and the pairing view in `/agentic-workflow:engineering status`. See below. |
| `worktreesDir` | `".workflow-worktrees"` | See hardening below. Set to `false` to opt out. |
| `worktreeSetup` | unset | Shell command run inside a freshly created worktree (e.g. `"npm ci"`). |
| `reviewLenses` | `[]` | See hardening below. Max 5 lenses. |

Both plugins read the same file: the schema lives in the shared core package
(`packages/core/src/config.ts`), and each host may extend it with fields only
it can honor (today: OpenCode's `watchIntervalMinutes` — see
[`plugins/claude/README.md`](../plugins/claude/README.md)).

## Workflow kinds (`workflows`)

Each key under `workflows` enables and configures one workflow kind (a
`packages/core/workflows/<kind>/` manifest). **`engineering` runs unless explicitly disabled**;
every other kind is opt-in with `"enabled": true`. Enabled kinds are polled in
claim-priority order: engineering first, then opted-in kinds in config order.

Kind-specific knobs ride along in the same section. **They are not validated**:
`workflows` is a loose record by design (kinds are user-authorable — see
[`packages/core/workflows/README.md`](../packages/core/workflows/README.md)), and the
loop reads each knob positionally by name with a bare type check. A misspelled
or wrongly-typed knob is therefore **silently ignored** — the loop runs on the
default and says nothing:

| Applies to kinds whose work source is | Knob | Read as |
|---|---|---|
| `pull-request` | `query` | string |
| `dependency-scan` | `severityFloor` | string |
| `dependency-scan` | `includeOutdated` | boolean |
| `dependency-scan` | `ecosystem` | string |
| `ci-runs` | `branch` | string |

(What each knob *means* per sitter is documented canonically in
[`sitters.md`](sitters.md); the table above is only the read contract.)

The admin hub's **Config tab flags exactly these mistakes** — unknown knob (with
a did-you-mean), wrong type, and a knob on a kind whose work source never reads
it. The warnings are advisory: they annotate a save, never block it. See
[the admin hub](#admin-hub-hub--user-scope-only) below.

> **The four sitters (`pr-sitter`, `review-sitter`, `dep-sitter`,
> `main-sitter`) are experimental** — their knobs and defaults below may still
> change between releases. `engineering` is the stable, default-on kind.

```json
{
  "workflows": {
    "engineering": { "enabled": true },
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    },
    "review-sitter": { "enabled": true },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

- **`workflows.engineering.enabled`** — default `true`; set `false` to run only
  other kinds (e.g. a dedicated PR-sitter watcher).
- **`workflows.pr-sitter`**, **`workflows.review-sitter`**, **`workflows.dep-sitter`**,
  **`workflows.main-sitter`** — each `enabled: false` by default. What each sitter
  does, its stage pipeline, and its full set of kind-specific keys
  (`query`, `ecosystem`, `severityFloor`, `includeOutdated`, `branch`, …) are
  documented once, canonically, in **[`docs/sitters.md`](sitters.md)** —
  don't duplicate that content here.
- **`workflows.<kind>.codePlatform`** — per-kind override of the global
  `codePlatform` (e.g. run the sitter against ADO while everything else
  defaults to GitHub).
- **`workflows.<kind>.trigger`** — how a watching host schedules claims for this
  kind (OpenCode `watch` mode only; the pull-only Claude host ignores it):

  ```json
  {
    "workflows": {
      "engineering": { "trigger": { "type": "idle" } },
      "pr-sitter": {
        "enabled": true,
        "trigger": { "type": "cron", "schedule": "0 9 * * 1-5" }
      }
    }
  }
  ```

  - `{ "type": "poll", "intervalMinutes"?: n }` — the default: a standing
    timer (falls back to `watchIntervalMinutes`), plus claims on idle events.
  - `{ "type": "cron", "schedule": "<5-field cron>" }` — claims fire **only**
    when the schedule fires; plain idle events never claim. A fire landing
    while the session is busy is skipped — the next fire retries. Syntax is
    validated at config load.
  - `{ "type": "idle" }` — no timer; a new loop starts as soon as the watching
    session goes idle, chaining loops back to back ("webhook-style" immediacy —
    no HTTP endpoint is involved).

  The config value is the **default**; `/agentic-workflow:<kind> watch` with an
  argument overrides it for that session only:
  `watch poll [interval]` (or a bare interval), `watch cron "<schedule>"`,
  or `watch idle`.

- **`workflows.<kind>.stageModels`** — stage name → the model that stage runs
  with, so cheap stages can run on a cheap model and hard stages on a strong
  one:

  ```json
  {
    "workflows": {
      "engineering": {
        "stageModels": {
          "build": "anthropic/claude-sonnet-4-5",
          "review": "anthropic/claude-opus-4-5"
        }
      }
    }
  }
  ```

  The value is a host-specific model string: OpenCode wants
  `provider/modelID` (as above); Claude Code wants a Task-tool model
  (`sonnet`, `opus`, `haiku`, or a bare model id — a `provider/` prefix is
  tolerated and stripped, so one shared config works on both hosts).
  Precedence per stage: this key → the manifest stage's `model` field →
  unset (the host's default model). Stages not listed keep the host default.

  Keys must be the kind's **stage names**, lowercase, as the manifest spells
  them (engineering: `plan`, `build`, `verify`, `review`; run
  `/agentic-workflow:<kind> kinds` for the others). A key that names no stage —
  `BUILD`, or a stage from another kind — cannot be rejected at parse time
  (the manifest isn't loaded yet), so it is accepted, ignored, and the stage
  runs the host default. Both hosts warn about such keys when a loop starts.

## Admin hub (`hub` — user scope only)

The hub reads its settings from the `hub` section of the **user-scope**
config only (`~/.config/agentic-workflow/agentic-workflow.json` / `AGENTIC_WORKFLOW_USER_CONFIG`). The hub
monitors many repos at once, so a `hub` key in a repo's `.agentic-workflow.json`
is ignored rather than merged:

```json
{
  "hub": {
    "repos": ["/path/to/repo", "/mnt/c/Users/me/projects/*"],
    "port": 4317
  }
}
```

- **`hub.repos`** — directories to monitor; entries may contain `*` wildcards
  (single path segment). Used only when the hub is launched without `--dir`
  flags.
- **`hub.port`** — listen port (default `4317`); `--port` still wins.

Unknown keys under `hub` are rejected (typo safety). See
[packages/hub/README.md](../packages/hub/README.md).

### Editing this file from the hub

The hub's **Config tab** reads and writes `.agentic-workflow.json`. Four behaviours
are worth knowing, because each exists to prevent a specific way of losing data:

- **It edits one layer at a time, and says which.** You pick *This repo* or
  *User (all repos)*; every field shows a badge for where its effective value
  actually comes from (`repo` / `user` / `default`). The merged view is never
  written back — doing so would flatten the user layer into the repo file,
  copying `ado.pat` into a file that may be committed.
- **Keys it doesn't recognise are preserved, and shown as preserved.** The
  editor writes raw JSON, so a host-only key (`watchIntervalMinutes`) or the
  `hub` section survives a save untouched. They're listed under *Preserved, not
  editable* — which also means a top-level typo appears there instead of
  vanishing silently.
- **`ado.pat` never reaches the browser.** It's replaced by a placeholder;
  leaving it untouched keeps the stored value. Writing a PAT into a repo file
  that **isn't gitignored is refused** — prefer `AZURE_DEVOPS_EXT_PAT`.
- **A save is refused unless the merged config validates**, and knob warnings
  (above) annotate it without blocking. Saving reloads the hub immediately; a
  hand-edit in `$EDITOR` is picked up too, so no restart either way.

The hub only writes the file. A loop already running picks up the new config at
its next stage; it is not re-read mid-stage.

## Code platform (`codePlatform` / `ado`)

Platform *mechanics* (config fields, auth, the ADO write-backstop) live here;
what each sitter kind actually does is in
[`docs/sitters.md`](sitters.md).

The PR sitter and review sitter bind to a hosted-PR work source
(`workSource.type: "pull-request"` in their manifests — the type names the kind
of work item, not the forge); which platform that source actually talks to is
resolved from config at wiring time — the manifest is never forked. (The type
was spelled `github-pr` before it grew ADO support; manifests using the old name
still load.) The manifest's `role` picks the ADO identity
filter: `author` kinds (pr-sitter) claim PRs created by `ado.selfLogin`,
`reviewer` kinds (review-sitter) claim other people's PRs where that login's
reviewer vote is still pending.

All four sitter kinds support Azure DevOps. The `dependency-scan`
(dep-sitter) source is platform-agnostic (npm reports don't care which forge
the repo lives on); its publish stage opens the draft PR via the ADO REST
API instead of `gh pr create` when the platform resolves to `ado`. The
`ci-runs` (main-sitter) source has a genuine ADO sibling
(`ado-ci-runs.ts`) that polls the Azure Pipelines Build REST API
(`_apis/build/builds`) instead of `gh run list`, normalizing build results
into the same judged shape the GitHub source produces — the "only the newest
head, never mid-run" logic is identical either way. Neither `dependency-scan`
nor `ci-runs` needs `ado.selfLogin` (unlike the PR-shaped sources, they
aren't scoped to an identity), but the PAT (`AZURE_DEVOPS_EXT_PAT`) is still
required.

Every sitter kind's publish stage — on ADO — opens PRs and posts thread
comments through the Claude host's write backstop hook (`check-stage-guard`),
which permits exactly three ADO write shapes: a read, a thread-comment
reply, and creating a brand-new draft pull request. Over REST that means a
GET, a POST to a `/threads` resource, and a POST to `.../pullrequests` with
no id segment (how ADO drafts a PR — `isDraft: true` in the body, the same
call as any other). Every mutation of an *existing* PR — completing,
abandoning, voting, adding reviewers, or any PATCH/PUT/DELETE — is blocked
outright, regardless of loop kind or stage; mutating-looking ADO MCP tool
names (should you have an Azure DevOps MCP server connected) are blocked
best-effort as defense-in-depth.

```json
{
  "codePlatform": "ado",
  "ado": {
    "organization": "https://dev.azure.com/acme",
    "project": "widgets",
    "repository": "widgets-api",
    "selfLogin": "sitter@acme.com"
  },
  "workflows": { "pr-sitter": { "enabled": true } }
}
```

Azure DevOps is reached **only through its REST API** — `curl` (with the PAT
as HTTP Basic auth) in the stage prompts, `fetch` in the driver's own poll
sources and ship gate. There is no `az` CLI and no MCP transport; the
`ado.customHeaders` and `ado.insecureSkipTlsVerify` knobs below always apply
to the driver's calls.

- **`ado.organization` / `ado.project`** — required ADO coordinates.
- **`ado.repository`** — optional for the `pr-sitter`/`review-sitter`/
  `main-sitter` kinds (omitted → `pr-sitter`/`review-sitter` see all active
  PRs across the project; `main-sitter` polls builds project-wide); **required**
  for opening a draft PR — the engineering loop's ship gate, and the
  `dep-sitter`/`main-sitter` publish stages — since creating a PR needs one
  specific repo. Unset it and those stages report they have nowhere to open
  a PR, rather than guessing.
- **`ado.selfLogin`** — **required**; the sitter's own login for filtering its
  own PR comments. A PAT can't resolve the sitter's identity — without it every
  comment (including the sitter's own replies) re-triggers attention.
- **`ado.pat`** — optional; the PAT in plaintext, as a fallback for when the
  `AZURE_DEVOPS_EXT_PAT` env var is unset. **The env var wins** when both are
  set. Prefer the env var; if you use `ado.pat`, the user-scope
  `~/.config/agentic-workflow/agentic-workflow.json` is the natural home (never committed, shared across
  repos) — in the repo file, keep `.agentic-workflow.json` gitignored (it is by
  default) so the secret is never committed. It reaches
  every consumer: the work source reads it directly, and the triage/publish
  stage agents (which authenticate via `$AZURE_DEVOPS_EXT_PAT`) get it exported
  for them — on OpenCode at plugin init (`applyAdoPatEnv`), on Claude Code via a
  `SessionStart` hook (`inject-ado-pat.mjs`) that writes it to `$CLAUDE_ENV_FILE`.
  Neither ever overrides a PAT you exported yourself.
- **`ado.customHeaders`** — optional; extra HTTP headers attached to every ADO
  REST call the driver makes (the `pr-sitter` work source and the engineering
  ship gate). Its home is a corporate proxy in front of Azure DevOps — e.g. a
  `Proxy-Authorization` token or a routing header. It's a plain string→string
  object; keys and values must be non-empty. The headers are merged **over** the
  built-in `Authorization`/`Accept`/`Content-Type`, so a key here can override
  one of those (rarely wanted, but yours to decide). The
  `AGENTIC_WORKFLOW_ADO_HEADERS` env var — a JSON object of the same shape —
  **overrides `customHeaders` key by key** (env wins, mirroring how
  `AZURE_DEVOPS_EXT_PAT` overrides `ado.pat`), so a secret proxy token can come
  from your secret manager while non-secret routing headers stay in config. A
  malformed env value is ignored (→ no override), never fatal. Like `ado.pat`,
  a header that carries a secret belongs in the user-scope `~/.config/agentic-workflow/agentic-workflow.json`
  (or the env var), not a committed repo file. Note this reaches only the
  driver's own `fetch` calls; the stage agents' raw `curl` (which authenticate
  via `$AZURE_DEVOPS_EXT_PAT`) do not inherit it — front those with the proxy's
  own environment (`HTTPS_PROXY` etc.) if they need it.

  ```json
  {
    "ado": {
      "organization": "https://dev.azure.com/acme",
      "project": "widgets",
      "repository": "widgets-api",
      "selfLogin": "sitter@acme.com",
      "customHeaders": { "X-Route": "internal-network" }
    }
  }
  ```

  ```bash
  # env var overrides / augments ado.customHeaders (JSON object, env wins on clashes)
  export AGENTIC_WORKFLOW_ADO_HEADERS='{"Proxy-Authorization":"Bearer proxy-token"}'
  ```
- **`ado.insecureSkipTlsVerify`** — optional, `false` by default; skip TLS
  certificate verification on every ADO REST call the driver makes (the
  PR/CI-runs work sources and the ship gate). It's for a self-hosted Azure
  DevOps Server sitting behind a self-signed or internal-CA certificate the
  runtime doesn't trust — never enable it against the hosted `dev.azure.com`
  service, since it drops protection against a MITM'd token. The calls go
  through a dedicated `undici` dispatcher, so this only weakens TLS for these
  ADO calls, not for unrelated requests (GitHub, npm, …) in the same process.
  Like `customHeaders`, it reaches only the driver's own `fetch` calls; the
  stage agents' raw `curl` does not inherit it — pass `-k`/`--insecure` (or
  point `curl` at your internal CA bundle) yourself if they need it too.

  ```json
  {
    "ado": {
      "organization": "https://ado.internal.acme.com/tfs/DefaultCollection",
      "project": "widgets",
      "selfLogin": "sitter@acme.com",
      "insecureSkipTlsVerify": true
    }
  }
  ```
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
  breadth tradeoff — the workflow.json/stage-marker path stays platform-narrow.

See [`workflows/README.md`](../packages/core/workflows/README.md) for authoring new kinds and
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
  `tracker.system` stamped on tasks authored via `/agentic-workflow:engineering new`.
- **`baseUrl`** — optional URL prefix a task's `tracker.key` is appended to,
  to build a deep link (Jira: `…/browse/`; ADO: `…/_workitems/edit/`). Unset →
  no link is built.
- **`defaultType`** — optional issue/work-item type stamped on new drafts
  (e.g. `story`, `task`, `bug`).

Pairing is always **optional** — a task never has to carry a `tracker` block;
this section only supplies authoring defaults and the status view.

Impact on the commands:

- **`/agentic-workflow:engineering new`** pre-fills `tracker.system` (and `type` from
  `defaultType`) so the drafted task is ready to pair — you fill in the
  `tracker.key`.
- **`/agentic-workflow:engineering status`** adds a `pairing` roll-up: the tracker system, how
  many active tasks are paired, and the ids of those still unpaired.

## Optional hardening

- **`worktreesDir`** — run each loop in its own `git worktree` instead of
  switching branches in the shared checkout. The human's tree is never
  touched and multiple `/agentic-workflow:engineering watch` sessions can build concurrently in one
  instance. **On by default** (`.workflow-worktrees`) — set `worktreesDir: false`
  to opt back into shared-tree branch switching. A fresh worktree has **no
  installed deps**: pair it with `worktreeSetup` (e.g. `"npm ci"`), or VERIFY
  will fail in a bare checkout. Audit notes and task moves stay in the main
  tree, subject to `ignoreBacklog` below.
- **`ignoreBacklog`** — keep `tasksDir` out of git entirely: instead of
  committing every task move (approve, plan, ship, park, done, stop) as an
  audit trail, the loop registers it in `<git-common-dir>/info/exclude` — a
  per-clone, untracked list, the same mechanism `worktreesDir` uses — so it
  never touches the shared, tracked `.gitignore`. **On by default** — set
  `ignoreBacklog: false` to restore the old committed-backlog behavior.
  Either way the task files themselves are unaffected on disk; only whether
  the loop commits their moves changes.
- **`reviewLenses`** — run REVIEW once per lens (e.g.
  `["correctness", "security", "test-adequacy"]`) and take the worst verdict,
  so a single prompt-injected reviewer can't wave a change through. Costs ~N×
  review time; off by default. Turning it on **suppresses the review stage's
  axis-coverage enforcement** (`requiredAxes`): each pass is told to focus on
  its own lens, so demanding all five axes from it would reject every pass.
  Lens mode enforces coverage its own way — a lens that records no verdict
  becomes an ERROR, not a silently missing opinion.
- Secrets echoed into audit notes, plans, or run logs are **shape-redacted**
  (`AKIA…`, `sk-…`, tokens, PEM blocks, `key/secret/token: …` assignments)
  before they are written and committed.
- On a terminal event the run log gets a **`## Run summary`** table — per-stage
  wall-clock, verdict history, and iterations used.

## Environment

One variable applies to **every host**:

- **`AGENTIC_WORKFLOW_USER_CONFIG`** — path of the user-scope config file
  (default `~/.config/agentic-workflow/agentic-workflow.json`); set to `""` to disable the layer. See
  [Layers & precedence](#layers--precedence).

The Claude Code MCP server additionally reads two directory pointers.
Neither applies to the OpenCode host, which takes its directory from the
project you opened.

- **`AGENTIC_WORKFLOW_DIR`** — the canonical repo root the server operates on:
  where the task backlog lives, where per-task worktrees are created under
  `worktreesDir`, and where run logs are written. Defaults to the server's
  working directory at launch. Set it when Claude Code roots the server
  somewhere other than the repo you mean.
- **`AGENTIC_WORKFLOW_BASE_DIR`** — where the **base branch** for a new
  `feature/<id>` worktree is read from. Claude Code freezes `AGENTIC_WORKFLOW_DIR`
  at the main checkout (usually the default branch), so without this every
  loop cuts from that branch. Point it at the tree you actually work in and
  the base is read there **live per claim** (`git rev-parse --abbrev-ref
  HEAD`), so `feature/<id>` branches off the branch you're on. Unset ⇒ the base
  falls back to whatever branch `AGENTIC_WORKFLOW_DIR` has checked out (the prior
  behavior). A detached base dir is ignored (same fallback).

See `design/threat-model.md` for the security posture and
`design/improvements/` for the design record behind these features.
