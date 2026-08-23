English | [繁體中文](configuration.zh-TW.md)

# Configuration (`.agentic-workflow.json`)

Optional JSON file at the repo root. Every field has a sane default; a
misconfigured file fails fast with a clear message instead of silently
falling back.

## Quick-start templates

Copy the block for your platform into `.agentic-workflow.json`, replace the
placeholders, done — everything else keeps its default. The rest of this
page is the field-by-field reference; you shouldn't need it for a first setup.

**GitHub** (the default platform — an empty file, or no
`.agentic-workflow.json` at all, already gives you `engineering`; the sitters
are experimental and stay off until you opt in with `"enabled": true`):

```json
{
  "workflows": {
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" }
  }
}
```

Replace `query` with the PR search you want the sitter to watch, or delete the
whole `workflows` block to take every default (`engineering` only).

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
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" }
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
`workflows.<kind>` section) merge per key recursively; arrays (a `stageFanout` lens list) and
scalars replace wholesale. Layers merge *before* validation, so defaults never
clobber an explicit value from either file, and cross-field requirements (like
`codePlatform: "ado"` needing `ado.selfLogin`) are checked against the
combined view — the intended split being:

- **User scope**: identity and credentials shared across repos —
  `ado.organization`, `ado.selfLogin`, `ado.pat` — plus personal defaults such
  as `maxIterations`.
- **Repo scope**: everything tied to the project — `codePlatform`,
  `ado.project`, `ado.repository`, `tasksDir`, `workflows`, worktree settings.

**Shell-bearing keys are the exception, and are honored from the USER layer
only**: `worktreeSetup`, `notifyCommand`, `workflows.<kind>.scannerCommand`
and `workflows.<kind>.stageChecks` are strings the loop hands to a shell
verbatim.
`.agentic-workflow.json` rides along with any cloned repo, so honoring them
there would let merely watching a repository run arbitrary shell on the first
claim — npm-postinstall-class risk, silently. Setting one in the repo layer
drops it with a warning naming the key (and, for the nested two, the kind); the
rest of that section still applies, and a user-layer value in the same section
survives.

**The ADO destination and credentials follow the same rule**, for the same
reason applied to a different asset: `ado.organization`, `ado.pat`,
`ado.mcp` is honored from the **user
layer only**. `organization` is the host your PAT is sent to, and
`pr-sitter`/`review-sitter` poll it on the first watch tick — so a cloned repo
setting it would aim your token at a host of its choosing without you running
anything. Set them in the repo layer and each is dropped with a warning naming
the key; `ado.project`, `ado.repository` and `ado.selfLogin` describe the
project and stay repo-settable. `ado.organization` must also be a real
`http(s)` URL.

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
| `checkTimeoutMinutes` | `10` | Wall-clock cap on ONE driver-run check command (`stageChecks` / the plan's discovered checks). Separate from `stageTimeoutMinutes`, which does not cover them: checks run outside the stage cap on both hosts. A check that exceeds it is killed and reported as exit `124` ⇒ stage ERROR. |
| `workflows` | `{}` | Per-workflow-kind sections — see below. |
| `codePlatform` | `"github"` | Which platform PR-shaped work sources talk to: `"github"` (the `gh` CLI) or `"ado"` (Azure DevOps — via the Azure DevOps MCP server + a PAT). Overridable per kind with `workflows.<kind>.codePlatform`. See below. |
| `shipPublish` | `"pr"` | What the ship gate publishes: `"pr"` (push the branch and open a draft PR), `"push"` (push the branch, open no PR), or `"local"` (publish nothing). Every mode still completes the task; only what leaves your machine changes. Overridable per ship. See below. |
| `prBase` | unset | The branch this repo's pull requests **target**, e.g. `"release/2.4"`. Unset does **not** mean `main` — it means ask the platform for its default branch. Outranked by the base a run was cut from and by a per-ship `--base=`. Overridable per kind with `workflows.<kind>.prBase`. See below. |
| `protectedBranches` | `[]` | Extra branches no loop stage may `git push`, **added** to the permanent `main`/`master`/`HEAD` floor. Additive only — the floor cannot be configured away. |
| `ado` | unset | Azure DevOps coordinates (`organization`, `project`, optional `repository`, `selfLogin`, `mcp`); **required** when any effective platform is `"ado"` — the config fails fast without it. `selfLogin` is **required** for `"ado"` (a PAT can't resolve the sitter's identity). |
| `projectManagement` | unset | The team's task tracker (Jira / Azure DevOps) and how local tasks pair to it. Drives task-authoring defaults and the pairing view in `/agentic-workflow:engineering status`. See below. |
| `worktreesDir` | `".workflow-worktrees"` | See hardening below. Set to `false` to opt out. |
| `worktreeSetup` | unset | Shell command run inside a freshly created worktree (e.g. `"npm ci"`). **Shell-bearing — user scope only**, see below. |
| `notifyCommand` | unset | Shell command fired after a terminal loop event — a plan parking for the plan gate, a run reaching the ship gate, a stop, an error — so gates don't go stale in scrollback nobody is watching. Runs as `sh -c <command>` with `AW_EVENT` (`park`\|`done`\|`stop`\|`error`), `AW_KIND`, `AW_TASK`, `AW_MESSAGE` in the environment; bounded (10s) and best-effort — a slow or failing notifier warns and never changes the outcome. E.g. `"notify-send \"agentic-workflow\" \"$AW_EVENT $AW_TASK: $AW_MESSAGE\""` or a `curl` to a chat webhook. **Shell-bearing — user scope only**, see below. |
| `notifyEvents` | unset (= all) | Which terminal events fire `notifyCommand` (subset of `["park","done","stop","error"]`). Not shell-bearing, so a repo may narrow — never widen — what its contributors get pinged about. |
| `taskBranch` | `"feature/"` | Branch-name prefix the engineering loop cuts its work branch with (`<prefix><id>`). Set to `false` to build on the branch you already have checked out — see hardening below. |

All three plugins read the same file: the schema lives in the shared core
package (`packages/core/src/config.ts`), and a host may extend it with fields
only it can honor — though none does today. Keys that used to exist and no
longer do are listed under [Retired keys](#retired-keys); a config that still
sets one loads fine and logs a warning naming its replacement.

## Workflow kinds (`workflows`)

Each key under `workflows` enables and configures one workflow kind (a
`packages/core/workflows/<kind>/` manifest). Exactly one kind is live with no
configuration at all:

- **`engineering` runs unless explicitly disabled** with `"enabled": false`.

Every other kind — all four sitters (`pr-sitter`, `review-sitter`,
`dep-sitter`, `main-sitter`) and any kind you author — is **experimental and
opt-in** with `"enabled": true`. A knob-only section does not enable a kind:
tuning `query` on a disabled `pr-sitter` leaves it off. Enabled kinds are
polled in claim-priority order: `engineering`, then the opted-in kinds in
config order — so a claim that names no kind reaches an enabled sitter too,
once nothing earlier in the order is claimable.

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

> **All four sitters are experimental** — their manifests, knobs, and defaults
> may still change between releases, which is why none of them starts without
> `"enabled": true`. `engineering` is the one kind whose defaults are settled.
> The `ado` code platform (below) is experimental on the same terms.

```json
{
  "workflows": {
    "engineering": { "enabled": true },
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

- **`workflows.engineering.enabled`** — default `true`; set `false` to run only
  other kinds (e.g. a dedicated PR-sitter watcher).
- **`workflows.pr-sitter`**, **`workflows.review-sitter`**,
  **`workflows.dep-sitter`**, **`workflows.main-sitter`** — every sitter is off
  until you set `"enabled": true`. What each sitter
  does, its stage pipeline, and its full set of kind-specific keys
  (`query`, `ecosystem`, `severityFloor`, `includeOutdated`, `branch`,
  `maxDiffLines`, …) are documented once, canonically, in
  **[`docs/sitters.md`](sitters.md)** — don't duplicate that content here.
- **`workflows.dep-sitter.scannerCommand`** — replace the bundled
  `osv-scanner --format json -L <target>` call on the JVM ecosystems with your
  own CLI (`{{target}}` / `{{ecosystem}}` are substituted). npm is unaffected.
  Its output may be an osv-scanner report or a raw OSV record list; the payload
  contract is in **[`docs/workflows/dep-sitter.md`](workflows/dep-sitter.md)**.
  **Shell-bearing — user scope only** (see below).
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
    timer (every 5 minutes when `intervalMinutes` is omitted), plus claims on
    idle events. A `watch <interval>` argument overrides it for that session.
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
  `provider/modelID` (as above); Claude Code and Qwen Code both want a
  Task-tool-style model (`sonnet`, `opus`, `haiku`, or a bare model id — a
  `provider/` prefix is tolerated and stripped, so one shared config works on
  all three hosts). Qwen resolves it at install time rather than spawn time —
  see [`docs/qwen.md`](qwen.md#per-stage-models-are-static-here). Precedence
  per stage: this key → the manifest stage's `model` field → unset (the
  host's default model). Stages not listed keep the host default.

  Keys must be the kind's **stage names**, lowercase, as the manifest spells
  them (engineering: `plan`, `build`, `verify`, `review`; run
  `/agentic-workflow:<kind> kinds` for the others). A key that names no stage —
  `BUILD`, or a stage from another kind — cannot be rejected at parse time
  (the manifest isn't loaded yet), so it is accepted, ignored, and the stage
  runs the host default. Both hosts warn about such keys when a loop starts.

- **`workflows.<kind>.stageContext`** — consuming stage name → per-artifact
  **character** ceilings on that stage's composed prompt. Unset ⇒ unbounded,
  which is byte-identical to having no budgets at all.

  Each stage's prompt carries the earlier stages' captured output verbatim, so a
  long BUILD transcript or a five-lens REVIEW lands whole in the next prompt.
  That is fine on a frontier model and fatal on a small one — which is exactly
  what `stageModels` invites. A budget is declared on the **consuming** stage,
  because the same artifact is read by several stages with different needs:

  ```jsonc
  {
    "workflows": {
      "engineering": {
        "stageModels": { "verify": "openrouter/qwen/qwen3-coder" },
        "stageContext": {
          "build":  { "goal": 16000, "plan": 24000, "verify": 8000, "review": 8000 },
          "verify": { "goal": 12000, "plan": 16000, "build": 8000 },
          "review": { "goal": 12000, "plan": 16000, "build": 8000 }
        }
      }
    }
  }
  ```

  Keys name the artifacts a stage consumes (`plan`, `build`, `verify`,
  `review`), plus one reserved key: **`goal`** clamps the task goal itself.
  The goal is already deduplicated at render — the plan section rides only in
  the `plan` artifact, and the audit-note tail is stripped — so a `goal`
  budget only bites on genuinely long task prose.

  This is a **small-context profile, not a default** — it is essential when you
  point a stage at a small model, and worth enabling (with looser ceilings) on
  frontier models too once a backlog runs long: artifacts grow with every
  iteration, and the prompt is largest exactly when the loop is struggling.
  Don't guess the ceilings — the hub Metrics tab's prompt-size panel shows each
  stage's composed prompt size and how much a budget elided, so set them from
  observed sizes and tighten until the elision marker starts appearing where it
  costs nothing. Convert with roughly 3.5–4 characters per
  token for prose and code, so 24,000 characters is ~6–7k tokens.

  Over-budget text is elided from the **middle**, keeping the head and the tail
  and leaving an explicit `[… N characters elided …]` marker, because a check
  stage opens with its verdict rationale and closes with the concrete failing
  assertions — a plain head-truncate throws away the half that names the file
  and line.

  Two things are never trimmed. The **structured verdict block** (verdict
  reason, failed criteria, blocking findings with `file:line`) is exempt: it is
  bounded by construction and is the highest-signal content in the prompt. And
  the stage's **contract** — goal, acceptance criteria, worktree instructions,
  the verdict/scope block — is composed after the budget applies. A budget can
  starve the history, never the contract.

  Nothing is lost: the full text of every pass is written to the durable run log
  before it becomes an artifact, so the run log and `runs/<id>.metrics.json`
  stay complete regardless of what the prompt carried.

  Precedence per stage: this key → the manifest stage's `context` field →
  unbounded. Like `stageModels`, this key **replaces** the manifest's map rather
  than merging into it. Keys must be stage names, and a key naming no stage — or
  an artifact naming no stage inside a valid one — is accepted, ignored, and
  warned about when a loop starts (the manifest isn't loaded when config
  parses). Unlike `worktreeSetup`, this key **is** honored from a repo's
  `.agentic-workflow.json`: the value space is positive integers, so a watched
  repo can shrink its own prompts and nothing else.

- **`workflows.<kind>.stageChecks`** — check stage name → the commands the
  **driver** runs in that stage's work tree before firing it. Their exit codes
  are established fact for the stage: rendered into its prompt, counted as
  observed evidence, and folded into its verdict. Unset ⇒ the stage falls back
  to the commands its approved plan declared (`discoverChecks`, below), and to
  no checks when the plan declared none.

  This is the test/typecheck/lint knob for a project whose commands you want to
  pin by hand. The problem both this and `discoverChecks` solve: left to itself,
  VERIFY picks the commands on every run — so the same repo at the same commit
  can be checked with `npm test` on one iteration and `npm test` plus `npx tsc`
  on the next, and the verdict moves without the code moving.

  ```jsonc
  {
    "workflows": {
      "engineering": {
        "stageChecks": {
          "verify": [
            { "name": "tests", "command": "npm test" },
            { "name": "types", "command": "npx tsc --noEmit" },
            { "name": "web-tests", "command": "npm test", "cwd": "packages/web" },
            { "name": "integration", "command": "./mvnw -B verify", "timeoutMinutes": 30 }
          ]
        }
      }
    }
  }
  ```

  `name` labels the result (unique per stage), `command` is shell run verbatim,
  `cwd` is an optional subdirectory of the work tree, and `timeoutMinutes` is an
  optional per-command cap that overrides `checkTimeoutMinutes`. Reach for it
  when one check is far slower than the rest: a single stage-wide cap has to be
  set by the slowest command, which leaves every faster one effectively
  unbounded — a 20-second lint beside a 25-minute integration suite would share
  the suite's budget and take 25 minutes to notice it had hung. They run sequentially,
  after isolation, once per stage firing — a five-axis REVIEW or a multi-lens
  one costs one run of the suite, not five.

  How an exit code binds the verdict:

  | Exit | Meaning | Effect |
  |------|---------|--------|
  | `0` | pass | nothing added; the verdict is exactly what the agent recorded |
  | `126`/`127` | the check could not run (not found / not executable) | stage **ERROR** → the loop stops for a human without burning an iteration |
  | anything else | the check ran and said no | stage **FAIL** → re-build, one iteration spent |

  A red check cannot be argued down: the stage can no longer PASS, whatever it
  reports. If a check is itself broken, the escape hatch is removing it from
  this list — not disputing it in the transcript. Each command is bounded by
  `checkTimeoutMinutes` (10 by default) unless it sets its own `timeoutMinutes`;
  a check that exceeds its cap is killed and reported as exit `124`, which reads
  as ERROR for the reason above.
  `stageTimeoutMinutes` does **not** cover checks — they run outside it on both
  hosts.

  Precedence per stage: this key → the manifest stage's `checks` field → the
  plan's discovered commands → none. Like `stageModels`, it **replaces** the
  manifest's list rather than merging into it. A **present but empty** list
  (`"verify": []`) is the explicit opt-out: it means "these are my project's
  checks, and there are none", so it also suppresses discovery. Keys must be
  check-stage names; one naming no stage is accepted, ignored, and warned about
  when a loop starts — that stage then falls back to discovery or to no checks
  at all, so the warning is worth reading.

  **Honored from the user layer only** (`SHELL_BEARING_WORKFLOW_KEYS`), like
  `worktreeSetup` and `scannerCommand`: it is shell the driver executes, and a
  cloned repo must not be able to supply it. Setting it in a repo's
  `.agentic-workflow.json` drops it with a warning naming the kind; the rest of
  that section, and a user-layer value for it, both survive.

- **`workflows.<kind>.discoverChecks`** — whether a check stage with no
  `stageChecks` entry and no manifest `checks` may take its commands from the
  **approved plan**. Unset ⇒ whatever the manifest stage declares; engineering's
  VERIFY declares it on, every other shipped stage off.

  The PLAN stage already has to map each acceptance criterion to "the exact
  command or observable check that proves it". With this on, its prompt also
  asks for those commands in machine-readable form — a fenced block at the end
  of `### Verification` — and tells it where to take them from, in order of
  authority: the repo's **CI workflow definition** first (those are the commands
  the project already enforces on every push), then `AGENTS.md`/`CLAUDE.md`
  where they name the check commands, then the package manifest's declared
  scripts. Only the test/typecheck/lint/build steps — a CI job's checkout,
  install, deploy or release steps are not the task's proof:

  ~~~markdown
  ### Verification
  - AC1 "rate limit returns 429" → `npm run test:all` (root package.json defines
    `test:all`; there is no bare `test` script)

  ```agentic-checks
  [
    { "name": "tests", "command": "npm run test:all" },
    { "name": "types", "command": "npm run typecheck:all" }
  ]
  ```
  ~~~

  Why the plan and not the check stage itself: **the commands must be frozen.**
  The block is text in the task file, re-read on every iteration, so
  BUILD→VERIFY→BUILD checks the same way each time. A stage that re-derived its
  commands per run would put back the drift described above. The only way the
  set changes is `replan`, which re-runs PLAN and re-parks for your gate.

  What it can run is capped by **the stage's own bash allowlist** — a discovered
  command is admitted only if the stage's agent could have run it unprompted.
  That is the boundary, not your approval of the plan: task files live in
  `tasksDir`, which is repo content, so a cloned repo could ship one. Commands
  are also capped at 8 — enough for a polyglot repo's front-end test, typecheck
  and lint beside a service's build, test and e2e, and few enough to still catch
  a plan that guessed — `cwd` must be a plain relative path inside the work tree,
  a `timeoutMinutes` may not exceed the stage's own wall-clock cap, and a command
  whose binary is not installed here is dropped with a warning rather than
  127-ing the run.

  One rule the allowlist cannot carry: a discovered command must **exit**. A dev
  server or a `--watch` runner is admissible (`npm run dev` matches `npm run *`)
  and its binary resolves, so nothing downstream drops it — it runs until
  `checkTimeoutMinutes`, reports exit `124`, and that is an ERROR, which stops
  the run for you. The PLAN prompt states the rule; to prove runtime behaviour,
  name the command that boots and stops the server itself (an e2e or integration
  run), never the serve command.

  Everything that can go wrong degrades to **fewer checks plus a warning** —
  never a refused plan and never a stopped loop. No block, malformed JSON, a
  refused command, a missing binary: the loop checks exactly as it did before
  the feature existed.

  Unlike `stageChecks`, this key is **not** shell-bearing and is honored from a
  repo's `.agentic-workflow.json`: its value space is one boolean, and turning
  it on grants a repo nothing it does not already have, since the allowlist
  gate is the same one its VERIFY agent already runs under.

  Turn it off with `"discoverChecks": false`, or by pinning your own commands —
  `"stageChecks": { "verify": [] }` disables both.

- **`agentModels`** — agent name → the model that agent runs with, for the
  spawns that are **not** stage runs and so have no `stageModels` entry to read:

  ```json
  {
    "agentModels": {
      "workflow-task-author": "anthropic/claude-haiku-4-5",
      "workflow-plan": "anthropic/claude-haiku-4-5"
    }
  }
  ```

  Two spawns qualify: the draft authoring `workflow-task-author` does for
  `/agentic-workflow:engineering new` and `retask` (it writes task files before
  any loop exists), and the ad-hoc `/agentic-workflow:plan` command's
  `workflow-plan`. Neither has a manifest stage behind it, so no fire payload
  carries a model for them.

  Top-level rather than per-kind: agent names are unique across kinds, and
  `workflow-plan` belongs to no kind at all. An unset agent runs the host default.

  **How each host binds it, and when a change takes effect.** Neither spawn is a
  stage fire, so neither can be handed a model through the driver the way a stage
  is. Each host binds it some other way — none of them by asking the model to
  cooperate, which is what the setting used to do and why it looked unreliable:

  | Host | Mechanism | A config change takes effect |
  | --- | --- | --- |
  | Claude Code | a `PreToolUse` hook rewrites the spawn call's `model` | on the next spawn |
  | OpenCode | the plugin's `config` hook sets `agent.<name>.model` | on the next **opencode restart** |
  | Qwen Code | `model:` baked into the installed agent file | on the next `./install.sh qwen` |

  **The value's spelling is host-specific**, and Claude Code is the strict one:

  - **OpenCode** takes real provider-qualified ids (`anthropic/claude-haiku-4-5`).
  - **Qwen Code** takes bare ids — a `provider/` prefix is stripped for you.
  - **Claude Code's spawn tool accepts only the aliases `sonnet`, `opus`,
    `haiku`, `fable`.** A configured id naming one of those families is mapped
    for you (`anthropic/claude-haiku-4-5` → `haiku`), but a value naming no known
    family cannot bind: that spawn runs the host default and the server reports a
    warning. It is deliberately left unbound rather than passed through — the
    tool validates `model` and **errors the whole spawn** on a value it does not
    accept, so passing an unmappable one would turn a cosmetic misconfig into a
    failed run.

  A typo'd *agent name* is likewise reported rather than silently ignored, since
  with the binding enforced it is the main remaining way an entry does nothing.

  **On OpenCode, precedence runs:** a stage fire's per-call model (`stageModels`,
  passed by the driver) > `agent.<name>.model` from this setting > your own
  `opencode.json` entry for an agent this setting does not name > the session
  default. `stageModels` is therefore never affected by `agentModels` on any host.

  Deliberately **separate from `stageModels`**, not folded into
  `stageModels.plan`: drafting and the PLAN stage are different jobs, run by
  different agents (`workflow-task-author` and `workflow-plan-author`), and only
  the second is a stage. Pointing drafting at a cheap model must not silently
  retarget planning, or vice versa. Setting `agentModels` never affects a stage;
  setting `stageModels` never affects drafting.

- **`bashAllowlistExtra`** — extra bash globs appended to **every stage that
  declares an allowlist** (check stages, and allowlisted work stages like
  pr-sitter's publish), after the manifest's own `bashAllowlist`. The
  per-project/per-user escape hatch for an environment the shipped manifests
  cannot know. You rarely have to reverse-engineer the glob yourself:
  `/agentic-workflow:engineering doctor` reports every denied command from the
  deny log with the exact `bashAllowlistExtra`/`bashAllowlistPrefix` change
  that would admit it (see design 29):

  ```json
  {
    "bashAllowlistExtra": ["rtk *"]
  }
  ```

  Two situations call for it:

  - **A project-specific runner.** VERIFY records ERROR naming a denied test
    command (`mise run test`, a bespoke script) — grant it here rather than
    editing the workflow manifest. Discovered checks honor the extras too, so a
    plan may name the granted runner.
  - **A command-rewriting proxy.** An rtk-style token saver rewrites every bash
    command (`git status` → `rtk git status`) *before* either host evaluates
    permissions, so every allowlisted command reaches the matcher in a shape no
    shipped glob matches and every check stage starves into ERROR. Reach for
    `bashAllowlistPrefix` below first — it covers this without widening
    anything. Extras remain the answer for what the proxy **renames**
    (see the snippet there).

  Declare **bare globs only** — the worktree `cd * && ` twins are derived where
  a host needs them, the same rule the manifests follow. A stage that declares
  no allowlist (engineering BUILD) stays unrestricted and gets nothing.

  These globs **widen the stage scope boundary** — that is their purpose — so
  breadth is your call. `"rtk *"` accepts anything the proxy emits, including
  `rtk npm publish` and `rtk gh pr merge`; prefer `bashAllowlistPrefix`, or
  finer globs, over that. The allowlist is a scope boundary against a confused
  agent, not a sandbox (see the threat model), but grant what your environment
  needs, not more.

  Takes effect like `agentModels`: next spawn on Claude Code, next **opencode
  restart** on OpenCode (the plugin's `config` hook appends the grants to each
  sentinel-guarded agent's permission map).

- **`bashAllowlistPrefix`** — command prefixes a rewriting proxy puts in front
  of the command a stage actually asked for. Each one re-expresses the globs the
  stage **already declares**, so nothing new is granted:

  ```json
  {
    "bashAllowlistPrefix": ["rtk"]
  }
  ```

  With that set, a stage granted `npm test*` also accepts `rtk npm test` — and
  still refuses `rtk npm publish`. That is the whole difference from a blanket
  `"rtk *"` extra, which accepts both. Extras are prefixed too, so a
  project-specific runner granted above is reachable through the proxy as well.

  It also **restores the write backstops**. Those classifiers anchor on the bare
  tool name (`git push …`, `gh pr merge`, `find … -delete`), so under any proxy
  they see `rtk …` and report no violation — `rtk git push --force origin main`
  included. The configured prefixes are stripped before each classifier runs, on
  both hosts. Nothing narrows this on its own: with the prefix configured,
  `rtk git push origin main` matches the derived `rtk git push origin *` glob
  quite legitimately, and only the classifier knows `main` is protected.

  Declare **bare command heads only** — no `*`, no shell metacharacters; an entry
  that is neither is dropped. Multi-word prefixes are fine (`"rtk proxy"`).

  **Residual: what the proxy renames.** Prefixing cannot predict a rewrite that
  changes the verb. rtk 0.42.3, for instance, turns `cat x` into `rtk read x`,
  `head -20 x` into `rtk read x --max-lines 20`, `npx tsc` into `rtk tsc`,
  `npx eslint .` into `rtk lint .`, `./gradlew build` into `rtk gradlew build`
  and `bundle exec rspec` into `rtk rspec`. Those need extras — still far
  narrower than `"rtk *"`:

  ```json
  {
    "bashAllowlistPrefix": ["rtk"],
    "bashAllowlistExtra": [
      "rtk read *", "rtk grep *", "rtk lint *", "rtk tsc*",
      "rtk vitest*", "rtk pytest*", "rtk gradlew *", "rtk rspec*"
    ]
  }
  ```

  That list is versioned with the proxy, not with this project — check what
  yours actually emits (`rtk rewrite "<cmd>"`) rather than trusting it. Many
  commands are not rewritten at all (`npm test`, `mvn test`, `dotnet test`) and
  need nothing.

  Takes effect exactly like `bashAllowlistExtra` above.

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
  editor writes raw JSON, so the `hub` section, a host-only key, or a retired
  one your file still carries survives a save untouched. They're listed under
  *Preserved, not editable* — which also means a top-level typo appears there
  instead of vanishing silently.
- **`ado.pat` never reaches the browser.** It's replaced by a placeholder;
  leaving it untouched keeps the stored value. Writing a PAT into a repo file
  that **isn't gitignored is refused** — prefer `AZURE_DEVOPS_EXT_PAT`.
- **A save is refused unless the merged config validates**, and knob warnings
  (above) annotate it without blocking. Saving reloads the hub immediately; a
  hand-edit in `$EDITOR` is picked up too, so no restart either way.

The hub only writes the file. A loop already running picks up the new config at
its next stage; it is not re-read mid-stage.

## Ship publishing (`shipPublish`)

Approving an `in-review/` task is the ship gate: the task moves to `completed/`
and the move is committed. `shipPublish` decides what — if anything — leaves
your machine at that moment.

| value | `git push` | pull request |
| --- | --- | --- |
| `"pr"` (default) | yes | draft PR opened, or an existing one reused |
| `"push"` | yes | none |
| `"local"` | no | none |

```json
{ "shipPublish": "local" }
```

The task is completed either way. `push` and `local` are **not** degraded ships
and raise no warning — a warning appears only when the mode you asked for came
up short (a `pr` ship that could not open one, a `push` that could not push).

It is a global key with no `workflows.<kind>` override, deliberately: the ship
gate is task-backed and only the `engineering` kind has one, so a per-kind
value could never fire.

### Choosing per ship

The config value is the default, not a decision you are stuck with:

| where | how |
| --- | --- |
| typed verb | `/agentic-workflow:engineering approve <id> --pr` (or `--push`, `--local`) |
| Claude Code / Qwen tools | `workflow_ship({id, publish: "local"})`, `workflow_approve({id, publish})` |
| OpenCode tool | `workflow_gate({id, publish})` |
| admin hub | the **publish** selector in the Ship dialog |

Omit it and the configured value applies. A misspelled flag is refused rather
than ignored — a ship that publishes more than you asked for cannot be undone.

### Publishing later

A `push` or `local` ship keeps its branch; nothing about the task is left
half-done. To publish it afterwards, ship the same task again:

```
/agentic-workflow:engineering approve <id> --pr
```

With a publish flag, an id naming a task already in `completed/` re-runs **only**
the publish step — it pushes the branch and opens the PR, and does nothing at all
once a PR is on record. The flag is what asks for it: a bare
`approve <id>` on a finished task still just reports that it already moved, and
pushes nothing. (The id-less `approve` never picks a completed task either; it
looks only at tasks waiting at a gate.)

On Claude Code and Qwen, `workflow_ship({id, publish: "pr"})` does the same
thing directly.

## PR base branch (`prBase`)

Not every team merges into the repo's default branch. If yours integrates on
`release/2.4`, that is where a shipped task's pull request should go — and
opening it against `main` shows reviewers a diff nobody approved.

The gate works this out for itself in the common case. When the loop cuts
`feature/<id>`, it records the branch it cut **from** on the task, and the ship
gate reads it back. So working on `release/2.4` needs no configuration at all:

```
git checkout release/2.4
/agentic-workflow:engineering new "…"    # → approve → plan → approve → claim
/agentic-workflow:engineering approve <id>   # PR targets release/2.4
```

`prBase` is for the cases that inference cannot cover — a repo whose task
branches are cut from anywhere, or a kind that should target somewhere else:

```json
{
  "prBase": "release/2.4",
  "workflows": { "dep-sitter": { "prBase": "main" } }
}
```

Unlike `shipPublish`, this **is** overridable per kind: `dep-sitter` and
`main-sitter` open pull requests of their own, so they can legitimately differ.

### Which base wins

Highest first:

| rung | source |
| --- | --- |
| 1 | `--base=<branch>` on this ship (or the `base` tool argument / hub field) |
| 2 | the branch this run was cut from, recorded on the task when it parked |
| 3 | `workflows.<kind>.prBase` |
| 4 | `prBase` |
| 5 | the platform's default branch (`gh repo view` / the ADO repo's `defaultBranch`) |
| 6 | the current branch, if it differs from the head; else `main` |

Rung 2 sits above the config on purpose: it is the ref REVIEW measured
`git diff <base>...<branch>` against, so it names the exact change you approved
at the in-review gate. Use `--base=` to retarget deliberately.

Tasks completed before this existed carry no recorded base and fall straight
through to rung 5 — exactly what they did before.

### Choosing per ship

```
/agentic-workflow:engineering approve <id> --base=release/2.4
```

Write it with the `=`. The space-separated `--base release/2.4` is **refused**,
because every host reads the first bare word as the task id — a silently
accepted spaced value would ship a task called `release/2.4`.

| where | how |
| --- | --- |
| typed verb | `approve <id> --base=release/2.4` |
| Claude Code / Qwen tools | `workflow_ship({id, base})`, `workflow_approve({id, base})` |
| OpenCode tool | `workflow_gate({id, base})` |
| admin hub | the **base branch** field in the Ship dialog |

A base **you asked for** that is not on `origin` **refuses the PR** rather than
quietly opening it against the default branch. The branch is still pushed, so the
fix is one command — `approve <id> --base=<correct>` re-runs only the publish
step. `refs/heads/`-qualified values are accepted and normalized.

A base nobody asked for on this ship — the branch the run recorded, or `prBase` —
is treated differently when it is missing from `origin`: the ship warns and lets
the platform name its own default instead of refusing. A run that had to fall
back during isolation records whatever the tree was parked on, which is often a
local-only branch, and a task that reached the ship gate cleanly should not end
up with no pull request at all over a branch you never chose.

## Protected branches (`protectedBranches`)

No loop stage may ever `git push` `main`, `master`, or `HEAD`. If your team's
integration branch is `release/2.4`, add it:

```json
{ "protectedBranches": ["release/2.4"] }
```

This is **additive only** — the built-in floor cannot be configured away. A
config that could unprotect `main` is a config that can be wrong about the one
branch that matters, and the failure would be silent until something had already
been pushed.

Deliberately separate from `prBase`: where pull requests target and what agents
may not push are different policies. An integration branch the loop *is* allowed
to push its own work onto is a legitimate setup, so one key cannot mean both.

## Code platform (`codePlatform` / `ado`)

> **`codePlatform: "ado"` is experimental** — the `ado` section's keys and
> defaults may still change between releases, on the same terms as the sitter
> kinds that consume it. `github` is the default and the settled path.

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
(`ado-ci-runs.ts`) that polls Azure Pipelines through the MCP server's
`pipelines_get_builds` tool instead of `gh run list`, normalizing build results
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

Azure DevOps is reached **only through the Azure DevOps MCP server**
([`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp), launched
with `npx`) — the stage agents call its tools by name, and the driver's own poll
sources and ship gate go through the same server. There is no `curl`, no `az`
CLI, and no REST fallback: one transport, so a stage prompt cannot drift out of
sync with the allowlist governing it.

**The server must be registered under exactly the name `azure-devops`.** Stage
prompts and generated agent frontmatter name tools as
`mcp__azure-devops__<tool>`; any other registration name makes every ADO stage
call a tool that does not exist. `./bootstrap.sh` registers it for you. This is
a constant rather than a setting because those names live in generated files
that CI diff-checks.

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
  The driver base64-encodes it into the MCP server's own
  `PERSONAL_ACCESS_TOKEN` when it launches the server — you never encode
  anything by hand. The stage agents use the server *you* registered, so their
  copy of the credential lives in that registration (which `./bootstrap.sh`
  writes).
- **`ado.mcp`** — optional; how the MCP server is launched. Every field has a
  working default, so most installs need none of it.
  - `command` (default `"npx"`) and `args` (default `["-y", "@azure-devops/mcp@<pinned>"]`)
    — point these at a locally installed binary for an air-gapped install. The
    version is **pinned** on purpose: the server's tool names are baked into
    stage prompts and generated agent frontmatter, so a floating version can
    rename the surface out from under them.
  - `authentication` (default `"pat"`) — `pat`, `azcli`, `envvar`, or
    `interactive`. Note the server's *own* default is `interactive`, which opens
    a browser; a polling loop has no one to click it, so the engine **refuses**
    that mode rather than hanging on a prompt nobody sees (set
    `ADO_MCP_ALLOW_INTERACTIVE=1` if you really are at a terminal).
    `envvar` reads a bearer token from `ADO_MCP_AUTH_TOKEN`.
  - `domains` (default `["repositories", "pipelines"]`) — which tool domains to
    load. Fewer tools is a smaller menu for the model.
  - `tenant` — Azure tenant id, for `interactive`/`azcli` against a
    multi-tenant organization.
  - `env` — extra environment for the spawned server, e.g.
    `NODE_EXTRA_CA_CERTS` for an internal CA or `HTTPS_PROXY`. **Not a place for
    secrets** — the PAT belongs in `ado.pat` (or the env var), which the hub
    knows to redact.

  ```jsonc
  {
    "ado": {
      "organization": "https://dev.azure.com/acme",
      "project": "widgets",
      "selfLogin": "sitter@acme.com",
      "mcp": { "env": { "NODE_EXTRA_CA_CERTS": "/etc/ssl/corp-ca.pem" } }
    }
  }
  ```

  `ado.mcp` is **user-layer-only**, alongside `organization` and `pat`: it names
  a command that gets spawned, so a cloned repo must not be able to choose it.

  Removed with the REST transport: `ado.access`, `ado.customHeaders`,
  `ado.insecureSkipTlsVerify`, and `AGENTIC_WORKFLOW_ADO_HEADERS`. A spawned MCP
  server has no per-request header or TLS seam. A stale key parses and is
  ignored, with a one-line warning naming it. Self-hosted Azure DevOps Server is
  **not supported** — the server takes an organization name and targets
  `dev.azure.com`.

- **Prerequisites for `"ado"`**: a Personal Access Token — in
  `AZURE_DEVOPS_EXT_PAT` (preferred) or `ado.pat` — scoped to Code (read) +
  Pull Request contribute (comment), plus Node 20+ with `npx` so the MCP server
  can start. No `az` CLI and no `curl` are needed.
- **Semantics on ADO**: failing checks come from the PR's validation
  **pipeline runs** — a repo whose PRs run no pipeline never fires
  `failing-checks`, and branch policies that are not pipelines (minimum
  reviewers, comment resolution, required work-item links) are **not visible**
  at all, because the MCP server exposes no policy tool. Comments come from PR
  threads; a negative reviewer vote maps to changes-requested;
  `mergeStatus: conflicts` maps to merge-conflict.
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

  With `worktreesDir: false`, a finished run **leaves your tree on
  `feature/<task-id>`** — the branch the work is on, which is where reviewing
  the diff, amending, and pushing all happen. The next run does not stack on it:
  a tree parked on one of the loop's own branches is re-based off the repo's
  default branch before the new branch is cut (`git checkout main` yourself
  first if you want a different base). One consequence, and only if you also set
  `ignoreBacklog: false`: task moves and audit notes are committed on the work
  branch rather than on the branch you started from.

  Two things are worth setting up on the **project** side before you run more
  than one watch session, because both fail in a way that is hard to read back
  from a transcript:

  - **Let checks bind ephemeral ports, never fixed ones.** Concurrent sessions
    mean concurrent worktrees, so two tasks can run the same integration suite
    or dev server at the same time. A service pinned to 8080, or a browser suite
    whose server is pinned to 3000, then fails on whichever started second — and
    that red is recorded as a genuine test failure, sending BUILD to fix a bug
    that does not exist. Use `server.port=0`, Testcontainers, or a port taken
    from the environment for anything a check runs. The loop cannot do this for
    you: it never sees inside the command it runs.
  - **Keep `worktreeSetup` cheap.** It runs once per fresh worktree, so a large
    dependency install is paid per task rather than per repo. A package manager
    with a shared global store (pnpm) or a warm cache costs far less here than a
    plain `npm ci`; toolchains whose cache is already global — Maven's `~/.m2`,
    Gradle's `~/.gradle` — cost nothing extra. A polyglot repo can chain both
    stacks in the one string with `&&`.
- **`taskBranch`** — what the engineering loop calls the branch it works on.
  The default `"feature/"` cuts `feature/<task-id>`. Set it to another prefix
  (`"wip/"`) to rename that, or to **`false`** to cut nothing at all: BUILD,
  VERIFY and REVIEW then run in your main working tree on **the branch you
  already have checked out** — for when you are mid-PR on a branch and want the
  loop's work to land there rather than on one of its own.

  `taskBranch: false` changes four things, and each is worth knowing before you
  set it:

  - **Worktrees are forced off** for that loop, whatever `worktreesDir` says
    (git will not check one branch out twice). The loop logs once when it drops
    a configured value.
  - **It refuses to start on your default branch.** This mode's checkpoints are
    `git add -A && git commit` in your own tree, so a run started from `main`
    would commit loop work straight onto it. Check out a working branch first.
  - **Your uncommitted changes ride into the loop's commits**, for the same
    reason — the checkpoint stages everything. Commit or stash first if you want
    them kept separate. (Shared-tree mode has always behaved this way; here it
    is the normal case rather than the exception.)
  - **One run per working tree.** Two loops sharing a branch would land inside
    each other's diff boundary and REVIEW would grade work nobody planned, so a
    second run on the same tree is refused while the first holds it — across
    processes, not just within one editor.

  Shipping is unchanged in shape: `approve` on an `in-review/` task pushes the
  branch the run actually built on and opens the same draft PR against your
  default branch. Only the **engineering** kind honors this key; the sitters keep
  `feature/<id>`, because their branch either comes from the work source
  (`pr-sitter`, `main-sitter`) or is pinned by their own push allowlist
  (`dep-sitter`).
- **`ignoreBacklog`** — keep `tasksDir` out of git entirely: instead of
  committing every task move (approve, plan, ship, park, done, stop) as an
  audit trail, the loop registers it in `<git-common-dir>/info/exclude` — a
  per-clone, untracked list, the same mechanism `worktreesDir` uses — so it
  never touches the shared, tracked `.gitignore`. **On by default** — set
  `ignoreBacklog: false` to restore the old committed-backlog behavior.
  Either way the task files themselves are unaffected on disk; only whether
  the loop commits their moves changes.
- **`workflows.<kind>.stageFanout`** — stage name → `"axis"`, `"none"`, or a
  **list of lenses**: run a check stage as several focused passes instead of one.
  The passes merge worst-wins, and **on OpenCode they run in parallel** —
  turning the fan-out on is the request for N focused passes, so it does not
  also need `stageConcurrency` to stop being slow. Set `stageConcurrency` to
  clamp that (see below); the Claude Code and Qwen Code hosts run the passes one
  at a time whatever you set.

  ```jsonc
  // one pass per required axis — coverage enforced
  { "workflows": { "engineering": { "stageFanout": { "review": "axis" } } } }
  // ...or your own angles, one pass each
  { "workflows": { "engineering": { "stageFanout": { "review": ["a hostile attacker", "the next maintainer"] } } } }
  ```

  Both forms cost ~N× the stage and both buy the same threat-model benefit: no
  single prompt-injected reviewer can wave a change through. They differ in what
  they can *guarantee*, and the difference is worth understanding before you
  pick:

  - **`"axis"`** enforces coverage **per pass** — each pass is held to its own
    axis, and the stage cannot advance with an axis uncovered; a gap stops the
    loop with ERROR rather than re-building on a review that never ran.
  - **A lens list** cannot be: a free-text angle maps to no axis, so a lens is
    told to report only the axes it actually bears on, and an axis it did not
    examine is left out rather than recorded as a clean PASS (the passes merge
    worst-wins, so a guess there would become the stage's verdict for an axis
    nobody reviewed). Whether the stage-wide check survives depends on the list:

    - **Lenses that between them name every required axis** (all five of
      engineering's, say) keep the guarantee — the *accumulated* record across
      the passes must still cover every axis.
    - **Lenses that don't** (e.g. `["security", "test-adequacy"]`) can't be held
      to axes they will never report, so the coverage check is off for that
      stage. Both hosts warn at startup naming exactly which axes go unreviewed.

  > **A one-entry lens list is a downgrade, not an upgrade.** With no fan-out at
  > all, the single review pass is admitted against *every* required axis.
  > `["security"]` replaces it with one pass admitted against **none** — four
  > axes lost, for a setting that reads like added scrutiny. Reach for `"axis"`
  > unless you specifically want angles the axis list cannot express.

  Either way a pass that records **no** verdict at all is an ERROR, not a
  silently missing opinion. Off by default; a stage with neither knob set is
  byte-identical to a single unfocused pass.

  `"none"` turns a fan-out declared in the manifest (`fanout` on the stage) back
  off. Config wins over the manifest, as with `stageModels` and `stageContext` —
  and it is how you reach the built-in kinds at all, since their manifests ship
  inside the `@agentic-workflow/core` package. A key naming no stage is accepted,
  ignored, and warned about, exactly like `stageModels`.

  The lens list absorbed the retired top-level `reviewLenses`
  ([Retired keys](#retired-keys)), which reached only the stage named `review`
  and silently won over a declared per-axis fan-out.
- **`workflows.<kind>.stageConcurrency`** — stage name → how many of that
  stage's focused passes may run **at once**. Unset, a per-axis `stageFanout`
  runs **all** its passes at once and everything else runs one at a time.
  Applies to every focused pass `stageFanout` produces, per-axis or lens.

  ```jsonc
  // clamp a five-axis fan-out to two passes in flight
  { "workflows": { "engineering": { "stageFanout": { "review": "axis" }, "stageConcurrency": { "review": 2 } } } }
  // ...or clamp a lens fan-out the same way
  { "workflows": { "engineering": { "stageFanout": { "review": ["a hostile attacker", "the next maintainer"] }, "stageConcurrency": { "review": 2 } } } }
  ```

  A fanned-out check stage's passes are independent by construction — each is a
  read-only review of the same work tree, told to cover its own axis or lens and
  not the others, merged worst-wins — so running them together is a latency win,
  not a semantic change: a five-axis review costs about one review instead of
  five. That is why the fan-out no longer waits for a second opt-in.

  It is still a **cost knob**: N passes in flight means N concurrent model
  sessions against your rate limit, so `1` is how a rate-limited setup takes a
  fanned-out stage back to sequential. The value is clamped to the stage's pass
  count, so a single-pass stage is unaffected whatever you set.

  **OpenCode only.** Each pass gets its own session there, which is what makes
  the per-pass verdict, axis requirement and evidence ledger separable. The
  Claude Code and Qwen Code hosts spawn pass subagents from the orchestrator
  while the MCP server keeps one armed pass, one stage marker and one evidence
  ledger — all three read by the guard hooks — so a pass has no identity to
  attribute a verdict or a tool call to; those hosts **warn** rather than
  silently ignoring the knob. A key naming no stage is accepted, ignored, and
  warned about, exactly like `stageModels`.
- **`workflows.<kind>.planVisualization`** — boolean: when `true`, the kind's
  plan-writing stage (the one with `planContract`) is prompted to include
  ```mermaid`` diagram(s) inside `## Implementation Plan` **when the change's
  shape warrants it** — state/lifecycle transitions, flow across two or more
  packages, concurrency or locking, data-shape changes. Agent-judged, never
  gate-enforced: `runPark` does not check for a diagram, and small or
  mechanical plans are told to skip it. The hub's plan-review view renders the
  fence as an actual diagram (in a sandboxed iframe, with a source toggle);
  per-block replan comments still anchor to it.

  ```jsonc
  { "workflows": { "engineering": { "planVisualization": true } } }
  ```

  Config wins over the manifest flag in both directions, as with `stageFanout`
  — and it is how you reach the built-in kinds at all, since their manifests
  ship inside the `@agentic-workflow/core` package. Off by default; unset is
  byte-identical to today. The value is one boolean — no shell, no path — so
  it is honored from the repo layer like `stageContext`.
- Secrets echoed into audit notes, plans, or run logs are **shape-redacted**
  (`AKIA…`, `sk-…`, tokens, PEM blocks, `key/secret/token: …` assignments)
  before they are written and committed.
- On a terminal event the run log gets a **`## Run summary`** table — per-stage
  wall-clock, verdict history, and iterations used.

## Retired keys

Keys that were removed, and what replaced each. A config still setting one
**loads normally** — the key is ignored, and the loop logs a warning naming the
replacement. Nothing fails, so there is no rush to edit; the warning is there so
a setting that stopped taking effect never does so silently.

| Retired | Use instead |
|---------|-------------|
| `watchIntervalMinutes` | `/agentic-workflow:engineering watch <interval>` for one session (e.g. `watch 30s`), or `workflows.<kind>.trigger` = `{"type":"poll","intervalMinutes":N}` to set it per kind and persist it. The old key was a *global* cadence applied to every watched kind at once. |
| `reviewLenses` | `workflows.<kind>.stageFanout.<stage>` — the same list, on the stage it applies to: `{"workflows": {"engineering": {"stageFanout": {"review": ["security"]}}}}`. Prefer `"axis"`, which covers **and enforces** every required axis; see the warning under [`stageFanout`](#workflow-kinds-workflows) about one-entry lens lists. |
| `ado.access`, `ado.customHeaders`, `ado.insecureSkipTlsVerify` | Nothing — Azure DevOps is reached only through its MCP server. Use `ado.mcp.env` (e.g. `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`) for transport concerns. |
| `gateBeforeBuild`, `interviewBeforePlan` | Nothing — both behaviours are now unconditional. Pre-1.0 keys; silently ignored. |

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
  behavior). A detached base dir is ignored (same fallback). One exception in
  both cases: if the branch read is one of the loop's own (`feature/…`), it is
  **not** used as a base — the repo's default branch is, so a tree still parked
  on the last task's branch doesn't stack the next task on top of it.

See `design/threat-model.md` for the security posture and
`design/improvements/` for the design record behind these features.
