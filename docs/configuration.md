# Configuration (`.agentic-loop.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

## Layers & precedence

Config is resolved from two optional layers:

1. **User scope** — `~/.agentic-loop.json`, applied to every repo you run the
   loop in. Override the path with `AGENTIC_LOOP_USER_CONFIG`; set it to `""`
   to disable the layer entirely (e.g. in CI).
2. **Repo scope** — `.agentic-loop.json` at the repo root, which **overrides
   the user layer field by field**.

The merge is a field-level deep merge: nested objects (`ado`, `loops`, each
`loops.<kind>` section) merge per key recursively; arrays (`reviewLenses`) and
scalars replace wholesale. Layers merge *before* validation, so defaults never
clobber an explicit value from either file, and cross-field requirements (like
`codePlatform: "ado"` needing `ado.selfLogin`) are checked against the
combined view — the intended split being:

- **User scope**: identity and credentials shared across repos —
  `ado.organization`, `ado.selfLogin`, `ado.pat` — plus personal defaults such
  as `maxIterations`.
- **Repo scope**: everything tied to the project — `codePlatform`,
  `ado.project`, `ado.repository`, `tasksDir`, `loops`, worktree settings.

Keep `codePlatform` and `loops` in the repo file by convention: a user-scope
value silently applies to *every* repo. If the user file holds a PAT, protect
it (`chmod 600 ~/.agentic-loop.json`); the `AZURE_DEVOPS_EXT_PAT` env var
still wins over both layers. On a mixed Windows/WSL setup note the two worlds
have different home directories — hosts running inside WSL resolve the WSL
home; point `AGENTIC_LOOP_USER_CONFIG` at one file if you straddle both.

`./install.sh` seeds this file for you: on an interactive terminal it runs a
short wizard (code platform, sitters, worktrees, plus an advanced gate for the
tracker, review lenses, and iteration cap) and writes a valid `.agentic-loop.json`.
Its first question is the **scope** — where to write:

- **repo scope** (default) — `<project>/.agentic-loop.json` in the directory the
  plugin reads config from at runtime (`$AGENTIC_LOOP_DIR`, else the current
  directory), which it prompts for. Per-project settings live here.
- **user scope** — the shared user-scope file (`$AGENTIC_LOOP_USER_CONFIG`, else
  `~/.agentic-loop.json`), read for every repo you drive. Settings shared across
  repos (the `ado` block, review lenses) belong here; a repo file overrides it
  field by field (see [Layers & precedence](#layers--precedence) above).

Force the scope non-interactively with `--user` or `--repo`. It never overwrites
an existing file and is skipped under piped/CI runs. Other flags: `--no-config`
skips it, `--config` forces it on, `-y`/`--yes` writes an all-defaults file
without prompting (honoring `--user`/`--repo`). Everything below can also be
hand-edited afterward.

| Field | Default | What it does |
|-------|---------|--------------|
| `maxIterations` | `3` | Max loop iterations before stopping on repeated check-stage failures (engineering: VERIFY/REVIEW; a manifest may override per kind). When the engineering cap trips, the plan is suspect — send it back with `/agentic-loop:engineering replan <id>`. |
| `tasksDir` | `"docs/tasks"` | Repo-relative root of the task backlog; its subfolders are task statuses. Also hosts the ephemeral `runs/` machine state (snapshots, stage marker, PR-sitter ledgers). |
| `stageTimeoutMinutes` | `60` | Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. |
| `watchIntervalMinutes` | `5` | Default polling cadence for `/agentic-loop:engineering watch`; overridable per session via `/agentic-loop:engineering watch <interval>`. **OpenCode-only** — this field is an extension the OpenCode plugin adds in `src/config.ts` on top of the shared core schema (`packages/core/src/config.ts`); the Claude Code plugin has no watch timer. |
| `loops` | `{}` | Per-loop-kind sections — see below. |
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI) or `"ado"` (Azure DevOps via its REST API, PAT auth). Overridable per kind with `loops.<kind>.codePlatform`. See below. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`, `customHeaders`); **required** when any effective platform is `"ado"` — the config fails fast without it. `selfLogin` is **required** for `"ado"` (a PAT can't resolve the sitter's identity). |
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

> **The four sitters (`pr-sitter`, `review-sitter`, `dep-sitter`,
> `main-sitter`) are experimental** — their knobs and defaults below may still
> change between releases. `engineering` is the stable, default-on kind.

```json
{
  "loops": {
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

- **`loops.engineering.enabled`** — default `true`; set `false` to run only
  other kinds (e.g. a dedicated PR-sitter watcher).
- **`loops.pr-sitter.enabled`** — default off; requires authenticated access
  to the platform: `gh` (GitHub), or a PAT in `AZURE_DEVOPS_EXT_PAT` (ADO).
- **`loops.pr-sitter.query`** — overrides the manifest's
  `gh pr list --search` query (default `is:open author:@me`) selecting which
  PRs the sitter watches. GitHub only — on ADO the sitter watches active PRs
  authored by its own identity.
- **`loops.review-sitter.enabled`** — default off; sits on PRs whose review
  is requested from this identity and posts one structured review comment per
  requested head (fetch → assess → publish). Comment-only authority: it never
  approves, votes, pushes, or merges. Re-fires only when a human pushes a new
  head; fork and draft PRs are skipped.
- **`loops.review-sitter.query`** — overrides the manifest's query (default
  `is:open review-requested:@me`). GitHub only — on ADO the sitter claims
  active PRs where `ado.selfLogin` is a reviewer whose vote is still pending
  (vote 0), never its own PRs.
- **`loops.dep-sitter.enabled`** — default off; sits on vulnerable
  dependencies and turns each auto-fixable direct-dependency upgrade into a
  verified draft PR (scan → upgrade → verify → publish). Major bumps are never
  auto-fixed — they are logged and left for a human. Three ecosystems: **npm**
  via the native `npm audit` / `npm outdated`; **Maven and Gradle (Spring
  Boot)** via [OSV-Scanner](https://google.github.io/osv-scanner/) —
  `osv-scanner --format json -L <pom.xml|gradle.lockfile>`, querying the
  OSV.dev database. The `osv-scanner` binary must be installed on the watcher
  host for the JVM ecosystems (missing → an actionable skip; npm keeps
  working without it). Gradle scanning needs dependency locking — osv-scanner
  cannot parse `build.gradle` itself; without a committed `gradle.lockfile`
  (or `gradle/verification-metadata.xml`) the kind skips with instructions to
  enable it. Vulnerable JVM packages not declared in the build files
  (transitives) are logged, never claimed — pinning a transitive is a human
  call, mirroring npm's direct-only rule. The publish stage opens the draft
  PR via `gh pr create` (GitHub) or the Azure DevOps REST API (`ado`).
- **`loops.dep-sitter.ecosystem`** — `auto` (manifest default: detect every
  ecosystem the repo declares — `package.json` / `pom.xml` /
  `build.gradle(.kts)` — and merge their candidates severity-first, so
  monorepos work) | `npm` | `maven` | `gradle` (scan only that one).
- **`loops.dep-sitter.severityFloor`** — minimum advisory severity that makes
  a vulnerable dependency claimable: `low` | `moderate` | `high` (manifest
  default) | `critical`. Applies uniformly: OSV advisories band their CVSS
  score into the same vocabulary.
- **`loops.dep-sitter.includeOutdated`** — default `false`; also claim
  non-vulnerable but outdated direct dependencies within the patch/minor
  policy. **npm only** — JVM staleness reporting would need build-plugin
  setup the sitter must not perform; ignored (with a log line) for
  maven/gradle.
- **`loops.main-sitter.enabled`** — default off; sits on the watched branch's
  CI (`gh run list`, or the Azure DevOps Build API on `ado`): when the newest
  head goes red it diagnoses (bisecting when needed) and publishes a verified
  draft fix/revert PR on a `main-sitter/*` branch (diagnose → remedy →
  verify → publish), commenting once on the culprit PR. The watched branch
  itself is never pushed.
- **`loops.main-sitter.branch`** — overrides the watched branch; unset ⇒ the
  remote default branch (from `origin/HEAD`, falling back to `main`).
- **`loops.<kind>.codePlatform`** — per-kind override of the global
  `codePlatform` (e.g. run the sitter against ADO while everything else
  defaults to GitHub).
- **`loops.<kind>.trigger`** — how a watching host schedules claims for this
  kind (OpenCode `watch` mode only; the pull-only Claude host ignores it):

  ```json
  {
    "loops": {
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

  The config value is the **default**; `/agentic-loop:<kind> watch` with an
  argument overrides it for that session only:
  `watch poll [interval]` (or a bare interval), `watch cron "<schedule>"`,
  or `watch idle`.

## Admin hub (`hub` — user scope only)

The hub reads its settings from the `hub` section of the **user-scope**
config only (`~/.agentic-loop.json` / `AGENTIC_LOOP_USER_CONFIG`). The hub
monitors many repos at once, so a `hub` key in a repo's `.agentic-loop.json`
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

## Code platform (`codePlatform` / `ado`)

The PR sitter and review sitter bind to a hosted-PR work source
(`workSource.type: "github-pr"` in their manifests); which platform that
source actually talks to is resolved from config at wiring time — the
manifest is never forked. The manifest's `role` picks the ADO identity
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
aren't scoped to an identity), but a PAT is still required.

Every sitter kind's publish stage — on ADO — opens PRs and posts thread
comments through the Claude host's write backstop hook (`check-stage-guard`),
which permits exactly three ADO write shapes: a GET read, a thread-comment
POST, and a POST creating a brand-new pull request (`.../pullrequests` with
no id segment — how ADO drafts a PR, `isDraft: true` in the body, is the same
call as any other). Every mutation of an *existing* PR — completing,
abandoning, voting, adding reviewers, or any PATCH/PUT/DELETE — is blocked
outright, regardless of loop kind or stage.

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
  `~/.agentic-loop.json` is the natural home (never committed, shared across
  repos) — in the repo file, keep `.agentic-loop.json` gitignored (it is by
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
  `AGENTIC_LOOP_ADO_HEADERS` env var — a JSON object of the same shape —
  **overrides `customHeaders` key by key** (env wins, mirroring how
  `AZURE_DEVOPS_EXT_PAT` overrides `ado.pat`), so a secret proxy token can come
  from your secret manager while non-secret routing headers stay in config. A
  malformed env value is ignored (→ no override), never fatal. Like `ado.pat`,
  a header that carries a secret belongs in the user-scope `~/.agentic-loop.json`
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
  export AGENTIC_LOOP_ADO_HEADERS='{"Proxy-Authorization":"Bearer proxy-token"}'
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

## Environment

One variable applies to **every host**:

- **`AGENTIC_LOOP_USER_CONFIG`** — path of the user-scope config file
  (default `~/.agentic-loop.json`); set to `""` to disable the layer. See
  [Layers & precedence](#layers--precedence).

The Claude Code MCP server additionally reads two directory pointers.
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
