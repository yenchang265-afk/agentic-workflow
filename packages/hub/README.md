English | [繁體中文](README.zh-TW.md)

# @agentic-workflow/hub

> **Beta.** The hub is functional and tested at the API level, but young:
> expect rough edges in the creator canvas UX, and the HTTP/JSON surface may
> still change without a migration path. See [Beta status](#beta-status).

A local admin hub for the agentic-workflow framework: **loop monitor** and
**visual loop creator**, served as one small web app.

```bash
pnpm hub --dir /path/to/repo    # from the repo root — builds core + hub, serves http://127.0.0.1:4317
node dist/server/main.js --dir /path/to/repo --port 4317        # direct, after building
node dist/server/main.js --dir /path/a --dir /path/b            # watch several repos
node dist/server/main.js --dir "/mnt/c/Users/me/projects/*"     # every loop repo under a parent
```

The hub only watches repos you name: with no `--dir` and no `hub` section in
the user-scope config it exits with a usage message rather than assuming the
cwd.

**Review queue** — the landing screen, and the hub's reason to exist. One row
per task waiting on a human, across every enabled backlog kind, longest-waiting
first, each carrying the evidence a gate decision needs: how long it has waited,
what the last run did, which stage failed, how much of the iteration budget it
burned, and what the plan opens with. `GET /api/review`.

**Loop monitor** — a board per kind, derived from its manifest: gate columns,
task cards carrying the human gate moves (approve / replan / ship), and run
history with per-stage token usage. The board is the inventory view; the queue
above is where the decisions are.

![Loop monitor board with gate columns and run history](docs/screenshots/monitor.png)

**Loop creator** — the manifest state machine on a canvas: stages, transitions,
and a side panel that edits the same `WorkflowManifestSchema` the engine runs.

![Loop creator canvas showing the engineering loop's stages and transitions](docs/screenshots/creator.png)

**Config** — edits `.agentic-workflow.json` one layer at a time, badging every
field with where its effective value comes from (`REPO` here).

![Config tab with REPO-sourced field badges](docs/screenshots/config.png)

## Monitoring multiple repos

`--dir` is repeatable, and values may contain `*` wildcards (`*` matches
within one path segment, never `/` or a leading dot — shell-glob style, quote
it so your shell doesn't expand it first). Explicit paths are watched
verbatim; wildcard matches are kept only when they look like loop repos
(`.agentic-workflow.json` or `docs/tasks` present), so a parent directory full of
unrelated checkouts stays quiet. Skipped matches are listed on stderr at
startup.

Instead of flags you can add a `hub` section to the **user-scope**
`~/.config/agentic-workflow/agentic-workflow.json` (honoring `$XDG_CONFIG_HOME`,
with the legacy `~/.agentic-workflow.json` still read as a fallback; or the file
`$AGENTIC_WORKFLOW_USER_CONFIG` points at).
It is used only when no `--dir` is given; `--port` still wins. The hub spans
repos, so a `hub` key inside any single repo's `.agentic-workflow.json` is
ignored:

```json
{
  "hub": {
    "repos": ["/path/to/repo", "/mnt/c/Users/me/projects/*"],
    "port": 4317
  }
}
```

Each repo gets a stable id (its basename, slugified, `-2`-suffixed on
collision). Repo-scoped API routes take `?repo=<id>` and default to the first
repo; `GET /api/repos` lists them. When more than one repo is monitored the
SPA header shows a repo picker (selection persists in localStorage), and SSE
events + gate notifications are tagged with the repo id. Workflow kinds are not
repo-scoped — they live in the core package shared by every repo, so the
creator tab is unaffected.

## Addresses, and what the URL carries

Every view has one. The hash names the screen and the selection —
`#/monitor/engineering?repo=web-app&run=fix-pagination`,
`#/review?task=plan-review/fix-pagination` — so a view can be linked,
bookmarked and reloaded, Back closes a drawer instead of leaving the app, and
switching sections no longer destroys what the previous one held.

Hash rather than real paths on purpose: the static handler maps a URL path to a
file under `dist/web` and 404s otherwise, which is the traversal and DNS-
rebinding rail. Real paths would need an SPA fallback punched through it — a
security-adjacent server change to buy a prettier URL on a localhost tool.

## Feedback

Mutations report through a toast **and** a session **activity log** (the
`Activity` button in the header), because a successful gate move relocates its
task and unmounts the card that would otherwise carry the confirmation. The log
lists **refused** moves too — those wrote no commit, so git cannot tell you they
happened. It is in-memory and session-scoped; git remains the durable record.

## Tabs

- **Review queue** (the landing screen): every task parked at a gate, across all
  enabled backlog kinds, longest-waiting first. Gate columns come from each
  manifest's park/done targets, so a kind that parks somewhere unusual is picked
  up for free. Each row carries the age (derived from the task's own audit
  trail — core stores no timestamps, and an untimestamped task reads "age
  unknown" rather than pretending to be new), the last run's outcome, the stage
  that failed, iteration burn against the cap, and the opening of the plan. A
  run's id is its task's id, so every row links straight to its run log.
  `GET /api/review`.

- **Loop monitor**: one sub-tab per enabled workflow kind, each view derived from
  the kind's manifest — backlog kinds get a board over their own
  `docs/tasks/<status>/` folders with gate columns taken from the manifest's
  park/done targets (not hardcoded), PR-shaped kinds get a ledger panel — plus
  the live-activity strip (each host's stage marker — Claude's `.stage.json`,
  OpenCode's `.stage-opencode.json`, Qwen's `.stage-qwen.json` — watch-lease
  liveness, resumable snapshots), run history parsed from `runs/<id>.md`, and
  per-stage token usage. Live updates via `fs.watch` + a polling reconciler
  (DrvFs-safe — DrvFs is WSL's `/mnt/c` Windows-drive filesystem, whose native
  file-watch events are unreliable, hence the polling fallback) → SSE
  (Server-Sent Events); arm the 🔔 to get a browser notification when a task
  parks at a gate.

  Task cards carry the **human gate moves** for their column — approve a draft
  or a parked plan, replan, ship — performed through the same
  `@agentic-workflow/core` entry points the hosts call, so a browser approval and a
  slash-command approval are the same audited, committed move. Each one is
  behind a confirm naming its real effect; **ship's confirm carries a publish
  choice** — open a pull request, push the branch with no PR, or ship fully
  local — defaulting to the repo's `shipPublish` and overridable per ship, and
  a **base branch** field for the pull request's target (blank ⇒ the branch the
  run was cut from, then the repo's `prBase`, then the platform default).
  The hub gates but never *drives*: it never claims work and never runs a
  stage, and it refuses a move on a task a loop is already driving.

  A `queued/` card additionally carries **Plan** — "plan this one next". It is
  the one button that is not a gate move: it writes a plan-request marker under
  `tasksDir/queued/.requests/`, moves no file and commits nothing, and the hub
  starts nothing itself. The next `claim` or `watch` tick reads the marker,
  plans that task ahead of the rest of the queued pool, and spends it; a request
  never preempts build-ready `in-progress/` work, and until one is honoured the
  button becomes **Cancel plan request**. So the "never drives a stage"
  line holds exactly as before — the hub writes an ordering hint and a driver,
  in its own process, decides what to do with it. A request whose task has since
  left `queued/` is inert, and the backlog doctor drops it.

  Clicking a card's title opens the **task drawer**: frontmatter, body, plan,
  and the audit timeline — with the gate moves in a sticky footer, so the plan
  can be read and approved in one place rather than read here and acted on back
  on the board. On a card, the forward move (approve / ship) is the button; the
  cancellations sit behind **More…**, which also means their confirm dialogs are
  only mounted when that menu is open. For a **planless** task — one in `draft/` or `queued/`
  with no `## Implementation Plan` — the drawer is also an **editor**: change the
  title, type, priority, labels, acceptance, and body, add a comment, and save.
  This is the hub's answer to the CLI's `retask`, which reshapes a task through
  an `interview-me` pass and a subagent rewrite; the hub has no agent, so the
  human types the reshape. Saving a **`queued/`** task therefore also sends it
  back to `draft/` and withdraws its task-gate approval — a goal the loop was
  approved to plan is not one you may change quietly. The comment lands on the
  audit note, where the next PLAN pass will read it.

  A task with a plan is not editable here — its goal was already planned
  against — so the drawer **reviews** it instead: body and plan rendered as
  Markdown (raw source one click away), where hovering any line offers a
  comment. Sending the comments performs the same `replan` the card's button
  does, with them composed into its reason; the task returns to `queued/`
  marked plan-next, so the next `claim`/`watch` re-plans it before the rest of
  the pool (the hub itself never drives a stage). Replan always took a reason, but it
  was typed into a textarea with none of the plan in front of it, so it came out
  vague and the next PLAN pass repeated the mistake; each comment quotes the
  block it hangs off, so the audit note still says *which step*:

  ```
  > Plan rejected — sent back to queued for re-planning — plan “Add an mtime-keyed cache in `manifest/load.ts`.”: mtime is not enough on DrvFs — key on size too. [2026-07-26T13:49:07.371Z by you]
  ```

  Comments live only in the open drawer — a composition aid for one gate move,
  not a review thread. What persists is that note, which is what the next pass
  reads. Columns with no comment-carrying move (`in-review`, `completed`) still
  get the rendered preview, without the affordance.

  The audit trail is never round-tripped through the browser: the editor is
  seeded with the body *minus* its trailing `> …` notes, and the server re-reads
  the file and rejoins its own copy of the trail at save time. A note appended
  while you were typing survives without the browser ever having seen it, and no
  client can delete one. An edit that would drop a note the editor *could* reach
  (one interleaved above later prose) is refused and names the line.

  ```mermaid
  sequenceDiagram
      actor Human
      participant UI as Hub SPA (browser)
      participant API as Hub server (/api/*)
      participant Core as @agentic-workflow/core entry point
      participant Git as Task backlog (git)

      Human->>UI: click gate move (approve / replan / ship)
      UI->>UI: confirm dialog names the real effect
      UI->>API: request (X-Hub-Client: 1, expectStatus)
      alt task is being driven by a live loop
          API-->>UI: 409 refused (loop is driving)
      else board is stale (expectStatus mismatch)
          API-->>UI: 409 stale board
      else clear to move
          API->>Core: same entry point the CLI / slash commands call
          Core->>Git: move task file + audited commit
          Core-->>API: ok (ship: publishes per the dialog's choice — PR, push, or local)
          API-->>UI: 200, board updates via SSE
      end
  ```

  Editing a planless task takes the same shape, with the drift checks an editor
  needs on top of the gate's stale-board check:

  ```mermaid
  sequenceDiagram
      actor Human
      participant UI as Task drawer (browser)
      participant API as Hub server (/api/tasks/:status/:id)
      participant Core as @agentic-workflow/core (rewriteTask / retaskTask)
      participant Git as Task backlog (git)

      Human->>UI: edit fields, add a comment, save
      UI->>API: POST prose only (never the audit tail) + baseHash
      Note over API: everything below shares the gate's per-repo lock
      alt task left its folder
          API-->>UI: 409 stale board
      else a plan appeared under the editor
          API-->>UI: 409 use Replan instead
      else the prose changed on disk (baseHash mismatch)
          API-->>UI: 409 reopen and reapply
      else frontmatter the editor can't preserve
          API-->>UI: 409 names the keys
      else a loop is driving it, or a secret is in the body
          API-->>UI: 200 refused (rendered like a gate refusal)
      else clear to save
          API->>API: rejoin the server's own audit tail
          API->>Core: rewriteTask (same id, filename, folder)
          Core->>Git: rewrite + audited note
          opt task was in queued/
              API->>Core: retaskTask (approval withdrawn)
              Core->>Git: move to draft/ + note, one commit
          end
          API-->>UI: 200, board updates via SSE
      end
  ```

  When the backlog has structural damage (a stray file, an invented folder, a
  claim marker a crashed loop left behind), the anomaly chip opens the
  **backlog doctor** — the same `workflow_doctor` repair the CLI runs. It rescues
  strays to `draft/`, removes empty stray folders, and releases the *stale,
  undriven* claim markers that would otherwise refuse a gate move forever;
  duplicate ids it only reports.
- **Loop creator**: the manifest state machine on a React Flow canvas —
  work/check stages as nodes, fire/park/done/stop transitions as edges,
  side-panel forms for stage fields (including the optional per-stage
  `model`), effects, work source, and stage prompts.
  Validation runs the real `WorkflowManifestSchema` (client-side for instant
  feedback, server-side on save). Save writes
  `packages/core/workflows/<kind>/workflow.json` + prompt stubs **only** and returns
  the checklist of steps it deliberately doesn't generate (agent personas,
  `gen:prompts`, command wrappers, hook registration, enablement).

  Each stage form can **preview its prompt** as the loop would compose it, with
  toggles for the optional state (task / git / worktree / platform) — a stage
  prompt is mostly conditional sections, and the mistake worth catching is a
  block that silently never fires.
- **Metrics**: cross-run loop health, rolled up from the same `runs/<id>.md`
  logs and `runs/<id>.metrics.json` sidecars the monitor reads one run at a
  time. Iteration burn and cap-trip rate (is the loop converging, or running out
  of iterations?), first-pass yield, per-stage verdict tallies with the
  fail→pass / pass→fail / fail→fail flip counts, outcome mix, per-stage
  wall-clock, and prompt-cache hit rate. `GET /api/metrics`.

  Two conventions make the numbers trustworthy, and both are visible in the UI:

  - **The unit is the pass, not the file.** One run log accumulates a plan pass
    and then a build pass — independent runs with their own cap and verdict
    stream — so the tab reports `runs` and `passes` separately and every rate
    names the population it measured.
  - **Unmeasurable is not zero.** A rate with no valid denominator renders `—`,
    never `0%`: "no pass recorded a cap" and "no pass tripped the cap" are
    different findings. Passes excluded from a rate are counted and stated.

  Known limits, stated in the tab's footer rather than hidden:
  the **cache hit rate covers opencode-driven runs only** (the Claude host never
  calls the LLM itself, so it observes no tokens; the transcript-attribution
  fallback the per-run token panel uses is deliberately *not* used here, because
  a ratio of two time-window estimates would disagree with the observed one with
  no way to reconcile them). Stage rows are namespaced by kind (a sitter's
  `build` renders as `pr-sitter/build`), with one caveat: **runs recorded before
  kinds were stamped carry no kind** and tally into the bare engineering rows —
  the right call for a history that is almost entirely engineering, but a very
  old sitter run can be misfiled there.
- **Config**: read and write `.agentic-workflow.json`. It edits **one layer at a
  time** (this repo, or user-scope) and badges every field with where its
  effective value actually comes from — the merged view is never written back,
  because that would flatten your user layer into the repo file and copy
  `ado.pat` into something you may well commit. Keys core's schema doesn't know
  (the `hub` section, a host-only key, a retired one) are preserved and
  listed as preserved, since the editor writes raw JSON rather than a parsed
  object. Per-kind knobs get advisory warnings — the loop reads them
  positionally, so a typo is otherwise silently ignored. Saving reloads the hub;
  so does a hand-edit in `$EDITOR`. See
  [docs/configuration.md](../../docs/configuration.md).

## Token usage sources

1. `runs/<id>.metrics.json` sidecar — exact, written by the opencode driver
   (tokens/cost/model per stage + sessionID) and by the Claude MCP server
   (timing/verdicts only; it never calls the LLM itself).
2. Claude transcripts (`~/.claude/projects/<slug>/*.jsonl`) — time-window
   attribution for Claude-host runs, flagged `estimated`.
3. `~/.local/share/opencode/opencode.db` — session-total backfill for old
   opencode runs; needs Node ≥ 22.13 (`node:sqlite`) and degrades with a
   reason otherwise.

## Safety model

Localhost tool, no auth by design: binds `127.0.0.1` only, rejects non-local
`Host` headers (DNS rebinding), never serves CORS, and mutating routes require
the `X-Hub-Client: 1` header (cross-origin pages can't send it without a
failing preflight). Task ids are slug-screened before they reach the
filesystem; workflow-kind writes are confined to `packages/core/workflows/<kind>/`,
slug-validated and prefix-checked.

The hub's writes, none of which drive a loop:

| Write | What it touches | Guard |
|---|---|---|
| Save a workflow kind (creator) | `packages/core/workflows/<kind>/` | slug + prefix check; 409 without `overwrite` |
| Scaffold an asset stub (creator) | `prompts/agents/<name>/`, `plugins/opencode/commands/<name>.md`, or `skills/<name>/` — one-shot TODO stubs | `X-Hub-Client`; slug + prefix check; 409 if the target exists (never overwrites); agent-referenced skills must already exist |
| Run the persona generator (creator checklist) | regenerates the checked-in `plugins/opencode/agents/*` + `plugins/claude/agents/*` files and normalizes opencode command `agent:` frontmatter — exactly what `pnpm gen:prompts` does in a terminal | `X-Hub-Client`; a confirm naming the effect; failure is reported with the generator's output, never half-applied routes |
| A human gate move (approve / replan / ship) | the task file under `tasksDir`, plus a git commit — and for **ship**, whatever the dialog's publish choice says (a draft PR, a push, or nothing off your machine) | `X-Hub-Client`; `expectStatus` (a stale board 409s rather than gate the wrong task); refused while a loop is driving the task; a confirm naming the effect |
| Edit a planless task (drawer) | the task file under `tasksDir` (rewritten in place — same id, filename, folder), plus a git commit; from **`queued/`** also the retask move back to `draft/` | `X-Hub-Client`; planless-only (a plan that appeared 409s); `expectStatus` **and** a content hash (a stale board or drifted prose 409s); frontmatter the schema can't preserve 409s rather than being stripped; the audit tail is rejoined server-side and re-verified; refused while a loop is driving the task or a claim is held; a body that scans as a secret is refused; a confirm naming the effect |
| Save config | one layer of `.agentic-workflow.json` | `X-Hub-Client`; layer-explicit (never the merged view); raw-JSON writes, so unknown keys survive; `ado.pat` redacted out and refused into a non-gitignored repo file; rejected unless the merged config validates |
| Request a plan (queued card) | one marker file under `tasksDir/queued/.requests/` — **no file move and no git commit** | `X-Hub-Client`; queued-only; `expectStatus` (a stale board 409s); refused on a task a loop is driving; a confirm naming the effect. Withdrawn by the same button |
| Backlog doctor fix | task files under `tasksDir` (rescue strays, remove empty stray folders, release **stale, undriven** claim markers, drop plan requests whose task has left `queued/`), plus a git commit | `X-Hub-Client`; releases a claim only when stale and not driven; skips claim release entirely while a watch lease is live; drops a stray request unconditionally (its task is gone, so nothing can be driving it); never resolves duplicate ids |

Creator write authority thus extends beyond `workflows/<kind>/` to the three asset
roots above — always as never-overwriting stubs the user finishes in an editor.

It never claims work, never runs a stage, and never merges anything — it writes
one ordering hint (the plan request) and still never claims. Full
analysis in [docs/design/threat-model.md](../../docs/design/threat-model.md)
(T14–T16), including the honest residual: **there is no authentication** — any
local process running as you can drive it, so don't run it on a shared host.

## Beta status

Solid (unit-tested + live-verified against this repo):

- every `/api/*` endpoint, the SSE watcher (fs.watch + polling reconciler),
  the run-log/metrics parsers, the graph↔manifest round-trip, and save guards

Known beta caveats:

- **A shipped kind opens read-only in the creator.** The save route has always
  refused to overwrite one; the toolbar now says so before the click and offers
  **Save as new kind** instead. Editing a shipped manifest in place stays an
  `$EDITOR` job.
- **The screenshots below predate the review queue** and the routed shell.
- **Creator canvas UX** has not had interactive browser QA — drag/connect and
  form flows work by construction but need real-mouse mileage; report
  anything janky
- **The task editor writes the schema's frontmatter fields only.** A task
  carrying an unknown key (`sprint:`, a tracker sync's own field) is refused
  with the key named rather than silently stripped — edit that file directly
- **opencode.db token backfill** needs Node ≥ 22.13 (`node:sqlite`); on older
  runtimes the panel says so and shows sidecar/transcript data only
- **Claude-host token numbers are estimates** (time-window attribution from
  transcripts) — always flagged `~` in the UI, never exact
- **API shape may change** between beta releases; the hub is a local tool,
  nothing external should depend on its JSON yet
- **Gate moves are refused while a loop is driving the task.** The hub reads
  that off the filesystem — a claim marker, or the stage marker — since it has
  no in-memory view of what a host is doing. A *stranded* claim (from a loop
  that crashed) reads the same way, so it will refuse until the claim is
  released; that is deliberate, because the alternative is re-queueing a task
  mid-BUILD and losing the work
- **Ship opens a real pull request** — the one hub action visible outside your
  machine

## Development

```bash
pnpm --filter @agentic-workflow/hub run dev        # esbuild --watch for the SPA (run the server via tsx separately)
pnpm --filter @agentic-workflow/hub run typecheck  # server + web tsconfigs
pnpm --filter @agentic-workflow/hub test       # node --test via tsx
```

The web bundle (`dist/web/`) is built locally, never checked in. Manual QA
that automated tests don't cover: creator drag/connect UX, SSE reconnect
after killing the server, the Notification permission flow, the confirm
dialogs on gate buttons, and a gate move attempted while a watcher is live —
open the hub in a real browser and click through both tabs.

The server bundle is built too (`dist/server/`), and a **stale `dist` is the
classic trap here**: `pnpm hub` rebuilds, but running
`node dist/server/main.js` directly after editing `src/` serves the old code —
a new route 404s and looks like a routing bug. Rebuild first.
