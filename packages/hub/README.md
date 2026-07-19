English | [繁體中文](README.zh-TW.md)

# @agentic-loop/hub

> **Beta.** The hub is functional and tested at the API level, but young:
> expect rough edges in the creator canvas UX, and the HTTP/JSON surface may
> still change without a migration path. See [Beta status](#beta-status).

A local admin hub for the agentic-loop framework: **loop monitor** and
**visual loop creator**, served as one small web app.

```bash
npm run hub -- --dir /path/to/repo    # from the repo root — builds core + hub, serves http://127.0.0.1:4317
node dist/server/main.js --dir /path/to/repo --port 4317        # direct, after building
node dist/server/main.js --dir /path/a --dir /path/b            # watch several repos
node dist/server/main.js --dir "/mnt/c/Users/me/projects/*"     # every loop repo under a parent
```

The hub only watches repos you name: with no `--dir` and no `hub` section in
the user-scope config it exits with a usage message rather than assuming the
cwd.

**Loop monitor** — a board per kind, derived from its manifest: gate columns,
task cards carrying the human gate moves (approve / replan / ship), and run
history with per-stage token usage.

![Loop monitor board with gate columns and run history](docs/screenshots/monitor.png)

**Loop creator** — the manifest state machine on a canvas: stages, transitions,
and a side panel that edits the same `LoopManifestSchema` the engine runs.

![Loop creator canvas showing the engineering loop's stages and transitions](docs/screenshots/creator.png)

**Config** — edits `.agentic-loop.json` one layer at a time, badging every
field with where its effective value comes from (`REPO` here).

![Config tab with REPO-sourced field badges](docs/screenshots/config.png)

## Monitoring multiple repos

`--dir` is repeatable, and values may contain `*` wildcards (`*` matches
within one path segment, never `/` or a leading dot — shell-glob style, quote
it so your shell doesn't expand it first). Explicit paths are watched
verbatim; wildcard matches are kept only when they look like loop repos
(`.agentic-loop.json` or `docs/tasks` present), so a parent directory full of
unrelated checkouts stays quiet. Skipped matches are listed on stderr at
startup.

Instead of flags you can add a `hub` section to the **user-scope**
`~/.agentic-loop.json` (or the file `$AGENTIC_LOOP_USER_CONFIG` points at).
It is used only when no `--dir` is given; `--port` still wins. The hub spans
repos, so a `hub` key inside any single repo's `.agentic-loop.json` is
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
events + gate notifications are tagged with the repo id. Loop kinds are not
repo-scoped — they live in the core package shared by every repo, so the
creator tab is unaffected.

## Tabs

- **Loop monitor**: one sub-tab per enabled loop kind, each view derived from
  the kind's manifest — backlog kinds get a board over their own
  `docs/tasks/<status>/` folders with gate columns taken from the manifest's
  park/done targets (not hardcoded), PR-shaped kinds get a ledger panel — plus
  the live-activity strip (`.stage.json` marker, watch-lease liveness,
  resumable snapshots), run history parsed from `runs/<id>.md`, and per-stage
  token usage. Live updates via `fs.watch` + a polling reconciler (DrvFs-safe)
  → SSE; arm the 🔔 to get a browser notification when a task parks at a gate.

  Task cards carry the **human gate moves** for their column — approve a draft
  or a parked plan, replan, ship — performed through the same
  `@agentic-loop/core` entry points the hosts call, so a browser approval and a
  slash-command approval are the same audited, committed move. Each one is
  behind a confirm naming its real effect; **ship also opens a pull request**.
  The hub gates but never *drives*: it never claims work and never runs a
  stage, and it refuses a move on a task a loop is already driving.

  When the backlog has structural damage (a stray file, an invented folder, a
  claim marker a crashed loop left behind), the anomaly chip opens the
  **backlog doctor** — the same `loop_doctor` repair the CLI runs. It rescues
  strays to `draft/`, removes empty stray folders, and releases the *stale,
  undriven* claim markers that would otherwise refuse a gate move forever;
  duplicate ids it only reports.
- **Loop creator**: the manifest state machine on a React Flow canvas —
  work/check stages as nodes, fire/park/done/stop transitions as edges,
  side-panel forms for stage fields (including the optional per-stage
  `model`), effects, work source, and stage prompts.
  Validation runs the real `LoopManifestSchema` (client-side for instant
  feedback, server-side on save). Save writes
  `packages/core/loops/<kind>/loop.json` + prompt stubs **only** and returns
  the checklist of steps it deliberately doesn't generate (agent personas,
  `gen:prompts`, command wrappers, hook registration, enablement).

  Each stage form can **preview its prompt** as the loop would compose it, with
  toggles for the optional state (task / git / worktree / platform) — a stage
  prompt is mostly conditional sections, and the mistake worth catching is a
  block that silently never fires.
- **Config**: read and write `.agentic-loop.json`. It edits **one layer at a
  time** (this repo, or user-scope) and badges every field with where its
  effective value actually comes from — the merged view is never written back,
  because that would flatten your user layer into the repo file and copy
  `ado.pat` into something you may well commit. Keys core's schema doesn't know
  (a host-only `watchIntervalMinutes`, the `hub` section) are preserved and
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
   opencode runs; needs Node ≥ 22.5 (`node:sqlite`) and degrades with a
   reason otherwise.

## Safety model

Localhost tool, no auth by design: binds `127.0.0.1` only, rejects non-local
`Host` headers (DNS rebinding), never serves CORS, and mutating routes require
the `X-Hub-Client: 1` header (cross-origin pages can't send it without a
failing preflight). Task ids are slug-screened before they reach the
filesystem; loop-kind writes are confined to `packages/core/loops/<kind>/`,
slug-validated and prefix-checked.

The hub's writes, none of which drive a loop:

| Write | What it touches | Guard |
|---|---|---|
| Save a loop kind (creator) | `packages/core/loops/<kind>/` | slug + prefix check; 409 without `overwrite` |
| Scaffold an asset stub (creator) | `prompts/agents/<name>/`, `plugins/opencode/commands/<name>.md`, or `skills/<name>/` — one-shot TODO stubs | `X-Hub-Client`; slug + prefix check; 409 if the target exists (never overwrites); agent-referenced skills must already exist |
| Run the persona generator (creator checklist) | regenerates the checked-in `plugins/opencode/agents/*` + `plugins/claude/agents/*` files and normalizes opencode command `agent:` frontmatter — exactly what `npm run gen:prompts` does in a terminal | `X-Hub-Client`; a confirm naming the effect; failure is reported with the generator's output, never half-applied routes |
| A human gate move (approve / replan / ship) | the task file under `tasksDir`, plus a git commit — and for **ship**, a draft pull request | `X-Hub-Client`; `expectStatus` (a stale board 409s rather than gate the wrong task); refused while a loop is driving the task; a confirm naming the effect |
| Save config | one layer of `.agentic-loop.json` | `X-Hub-Client`; layer-explicit (never the merged view); raw-JSON writes, so unknown keys survive; `ado.pat` redacted out and refused into a non-gitignored repo file; rejected unless the merged config validates |
| Backlog doctor fix | task files under `tasksDir` (rescue strays, remove empty stray folders, release **stale, undriven** claim markers), plus a git commit | `X-Hub-Client`; releases a claim only when stale and not driven; skips claim release entirely while a watch lease is live; never resolves duplicate ids |

Creator write authority thus extends beyond `loops/<kind>/` to the three asset
roots above — always as never-overwriting stubs the user finishes in an editor.

It never claims work, never runs a stage, and never merges anything. Full
analysis in [docs/design/threat-model.md](../../docs/design/threat-model.md)
(T14–T16), including the honest residual: **there is no authentication** — any
local process running as you can drive it, so don't run it on a shared host.

## Beta status

Solid (unit-tested + live-verified against this repo):

- every `/api/*` endpoint, the SSE watcher (fs.watch + polling reconciler),
  the run-log/metrics parsers, the graph↔manifest round-trip, and save guards

Known beta caveats:

- **Creator canvas UX** has not had interactive browser QA — drag/connect and
  form flows work by construction but need real-mouse mileage; report
  anything janky
- **opencode.db token backfill** needs Node ≥ 22.5 (`node:sqlite`); on older
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
npm run dev -w @agentic-loop/hub        # esbuild --watch for the SPA (run the server via tsx separately)
npm run typecheck -w @agentic-loop/hub  # server + web tsconfigs
npm run test -w @agentic-loop/hub       # node --test via tsx
```

The web bundle (`dist/web/`) is built locally, never checked in. Manual QA
that automated tests don't cover: creator drag/connect UX, SSE reconnect
after killing the server, the Notification permission flow, the confirm
dialogs on gate buttons, and a gate move attempted while a watcher is live —
open the hub in a real browser and click through both tabs.

The server bundle is built too (`dist/server/`), and a **stale `dist` is the
classic trap here**: `npm run hub` rebuilds, but running
`node dist/server/main.js` directly after editing `src/` serves the old code —
a new route 404s and looks like a routing bug. Rebuild first.
