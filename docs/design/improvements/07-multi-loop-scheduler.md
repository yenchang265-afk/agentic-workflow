English | [繁體中文](07-multi-loop-scheduler.zh-TW.md)

# 07 — Multi-loop kinds on a common scheduler

## Context

The repo hardcoded ONE agentic loop: the engineering PLAN → BUILD → VERIFY →
REVIEW pipeline over the `docs/tasks/` folder backlog. The pipeline shape,
transitions, prompt composition, status folders, and stage commands were
literals spread across `state.ts` and both drivers — and the two drivers were
themselves a fork: the OpenCode plugin (`src/`) and the Claude MCP server
(`claude-plugin/mcp-server/src/lib/`) duplicated the state machine, store,
git, and persist modules, so every change landed twice.

Goal: support many kinds of agentic loops — the engineering workflow, a PR
sitter, future kinds — sharing one scheduler, without changing the
engineering loop's observable behavior.

## What shipped (four increments, each landing green)

1. **`@agentic-loop/core`** (`packages/core/`, npm workspaces): the pure loop
   engine and every host-agnostic module (task store, git + isolate, persist,
   verdict, metrics, config) moved into one built package both plugins
   consume. The MCP fork (`src/lib/`, ~18 files) was deleted; `shim.ts` now
   merely implements core's host interfaces (`host.ts`: `Shell`, `Client`,
   `Log`).
2. **Manifest engine**: a loop kind is a folder `loops/<kind>/` — `loop.json`
   (zod schema: stages, work/check kinds, transition table with
   fire/park/done/stop effects, iteration caps, work-source binding, gates,
   per-stage bash allowlists) plus `stages/*.md` prompt templates. The pure
   engine (`core/src/loop/engine.ts`: `advance`/`composePrompt`/`firstStep`)
   interprets them; named TS hooks in `manifest/registry.ts` are the escape
   hatch for logic a manifest can't express. `loops/engineering/` transcribes
   the original pipeline.
3. **Work sources + scheduler**: `source/types.ts` defines
   `WorkItem`/`WorkSource` (`claimNext`/`release`/optional `onTerminal`);
   `scheduler/scheduler.ts` `pollOnce` walks the enabled kinds' sources in
   claim-priority order. The backlog-folder source (`source/backlog.ts`)
   recomposes the store's atomic `.claims/` walk behind the interface. Config
   gains a `loops.<kind>` section (engineering default-on, others opt-in).
4. **PR sitter** (`loops/pr-sitter/`): TRIAGE → FIX → VERIFY → PUBLISH over
   the `github-pr` source (`source/github-pr.ts` + `source/ledger.ts`).

## Key design decisions

- **Core is a BUILT package, not shared source.** The OpenCode plugin
  compiles with `moduleResolution: "bundler"` + `.ts` imports (Bun runs
  source); the MCP server with `NodeNext` + `.js` imports emitting `dist/`.
  One source tree can't satisfy both compilers, so core builds to `dist/`
  (NodeNext, declarations) and both consume it via subpath exports
  (`@agentic-loop/core/loop/engine`). The root `prepare` script builds core
  on `npm install`.
- **Golden parity before deletion.** The pre-manifest
  `composeArgs`/`advanceOnIdle` are frozen VERBATIM inside
  `core/src/loop/engine.test.ts` as the oracle; the suite asserts the engine
  reproduces them byte-for-byte (prompts) and deep-equal (states/actions)
  across the whole transition table, using the real
  `loops/engineering/` files. Only then were the legacy functions deleted.
- **Prompt templates are sectioned, not free-form.** A stage prompt file is
  `---`-separated sections; each renders independently ({{var}} dot-path
  interpolation, `{{#path}}…{{/path}}` truthiness blocks), empty sections are
  dropped, survivors join with a blank line — exactly the "parts" model the
  original `composeArgs` used, which is what makes byte-parity achievable.
  Derivable context (the review diff command, the worktree-pinning paragraph)
  is precomputed by the engine (`promptContext`), so ordinary kinds need no
  compose hooks.
- **Folder statuses stay engineering-specific.** Status folders are a
  property of the backlog work source (named in its manifest binding), not a
  global concept: the PR sitter has no folders at all — GitHub plus its
  ledger are the state. The store's typed 7-folder lifecycle was deliberately
  NOT parameterized yet (no second backlog-backed kind exists to shape it).
- **`onTerminal` closes the source loop.** Drivers report every terminal
  action (done/park/stop/error) back to the claiming source. The backlog
  source needs nothing (terminal bookkeeping rides the task file); the PR
  source settles its ledger and claim marker there.
- **Ledger watermarks kill self-triggering.** PUBLISH's `onTerminal` re-reads
  the PR and records the post-push head SHA and newest comment timestamp as
  handled — the sitter's own push/replies can never re-trigger it. A
  capped/stopped run records a `failedAttempt` pinned to the claimed head, so
  the PR parks until a human push changes the SHA. Own-login comments are
  filtered at poll time.

## Feature → code path

| Concern | Where |
|---|---|
| Manifest schema + validation | `packages/core/src/manifest/schema.ts` |
| Prompt template language | `packages/core/src/manifest/template.ts` |
| Hook/predicate registry (escape hatch) | `packages/core/src/manifest/registry.ts`, `kinds/engineering.ts` |
| Manifest loading (`loops/<kind>/`) | `packages/core/src/manifest/load.ts` |
| Pure engine (advance/composePrompt) | `packages/core/src/loop/engine.ts` (+ golden parity in `engine.test.ts`) |
| Work-source contract | `packages/core/src/source/types.ts` |
| Backlog source (engineering) | `packages/core/src/source/backlog.ts` |
| GitHub-PR source + dedup ledger | `packages/core/src/source/github-pr.ts`, `source/ledger.ts` |
| Scheduler tick | `packages/core/src/scheduler/scheduler.ts` (`pollOnce`) |
| Per-kind config + enablement | `packages/core/src/config.ts` (`loops`, `enabledLoopKinds`) |
| OpenCode wiring (watch/idle → pollOnce) | `src/loop/driver.ts` (`tryClaim`, `sourcesFor`, `drive` returns the terminal outcome) |
| Claude wiring (`loop_claim` → pollOnce) | `claude-plugin/mcp-server/src/server.ts` |
| Stage guard (marker allowlists) | `claude-plugin/hooks/check-stage-guard.mjs` + `runs/.stage.json` `{kind, bashAllowlist}` |
| PR-sitter stage personas | `.opencode/agents/loop-pr-*.md`, `claude-plugin/agents/loop-pr-*.md` |

## Limitations / follow-ups

- **Fork PRs are skipped** (`isCrossRepository`) — the sitter can't push the
  head branch back, and building attacker-authored branches unattended is an
  explicit non-feature (threat model T10).
- **Single-repo `gh`**: the source polls the current checkout's repo only.
- **No per-kind status folders yet**: a second backlog-backed kind will force
  the `makeLifecycle` parameterization of the store's typed status set.
- **MCP stays single-active-loop**; OpenCode serializes per working dir in
  shared-tree mode — concurrency policy remains per-host, by design.
- **`loop_start <id>` / gates / recover remain engineering verbs**; PR-sitter
  work arrives only through the scheduler (`watch` / `loop_claim`).
