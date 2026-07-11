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

- **Loop monitor** (read-only): one sub-tab per enabled loop kind, each view
  derived from the kind's manifest — backlog kinds get a board over their own
  `docs/tasks/<status>/` folders with gate columns taken from the manifest's
  park/done targets (not hardcoded), PR-shaped kinds get a ledger panel — plus
  the live-activity strip (`.stage.json` marker, watch-lease liveness,
  resumable snapshots), run history parsed from `runs/<id>.md`, and per-stage
  token usage. Live updates via `fs.watch` + a polling reconciler (DrvFs-safe)
  → SSE; arm the 🔔 to get a browser notification when a task parks at a gate.
- **Loop creator**: the manifest state machine on a React Flow canvas —
  work/check stages as nodes, fire/park/done/stop transitions as edges,
  side-panel forms for stage fields, effects, work source, and stage prompts.
  Validation runs the real `LoopManifestSchema` (client-side for instant
  feedback, server-side on save). Save writes
  `packages/core/loops/<kind>/loop.json` + prompt stubs **only** and returns
  the checklist of steps it deliberately doesn't generate (agent personas,
  `gen:prompts`, command wrappers, hook registration, enablement).

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
failing preflight). The only writable path is `packages/core/loops/<kind>/`,
slug-validated and prefix-checked.

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
- The monitor is deliberately **read-only** — gate actions (approve/replan
  buttons) are a candidate for a later release

## Development

```bash
npm run dev -w @agentic-loop/hub        # esbuild --watch for the SPA (run the server via tsx separately)
npm run typecheck -w @agentic-loop/hub  # server + web tsconfigs
npm run test -w @agentic-loop/hub       # node --test via tsx
```

The web bundle (`dist/web/`) is built locally, never checked in. Manual QA
that automated tests don't cover: creator drag/connect UX, SSE reconnect
after killing the server, and the Notification permission flow — open the hub
in a real browser and click through both tabs.
