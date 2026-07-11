# @agentic-loop/hub

A local admin hub for the agentic-loop framework: **loop monitor**, **visual
loop creator**, and the **user manual**, served as one small web app.

```bash
npm run hub            # from the repo root — builds core + hub, serves http://127.0.0.1:4317
node dist/server/main.js --dir /path/to/repo --port 4317   # watch another repo
```

## Tabs

- **Loop monitor** (read-only): backlog board over `docs/tasks/<status>/`
  with gate highlights, live-activity strip (`.stage.json` marker, watch-lease
  liveness, resumable snapshots, pr-sitter ledgers), run history parsed from
  `runs/<id>.md`, and per-stage token usage. Live updates via
  `fs.watch` + a polling reconciler (DrvFs-safe) → SSE; arm the 🔔 to get a
  browser notification when a task parks at a gate.
- **Loop creator**: the manifest state machine on a React Flow canvas —
  work/check stages as nodes, fire/park/done/stop transitions as edges,
  side-panel forms for stage fields, effects, work source, and stage prompts.
  Validation runs the real `LoopManifestSchema` (client-side for instant
  feedback, server-side on save). Save writes
  `packages/core/loops/<kind>/loop.json` + prompt stubs **only** and returns
  the checklist of steps it deliberately doesn't generate (agent personas,
  `gen:prompts`, command wrappers, hook registration, enablement).
- **User manual**: `docs/manual.html` in an iframe, with a drift banner
  diffing its command mentions against the hosts' real `argument-hint`
  surfaces.

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

## Development

```bash
npm run dev -w @agentic-loop/hub        # esbuild --watch for the SPA (run the server via tsx separately)
npm run typecheck -w @agentic-loop/hub  # server + web tsconfigs
npm run test -w @agentic-loop/hub       # node --test via tsx
```

The web bundle (`dist/web/`) is built locally, never checked in. Manual QA
that automated tests don't cover: creator drag/connect UX, SSE reconnect
after killing the server, and the Notification permission flow — open the hub
in a real browser and click through all three tabs.
