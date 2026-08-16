English | [繁體中文](29-deny-telemetry.zh-TW.md)

# 29 — Doctor reads the deny log

**Status: implemented.**

## The problem

Allowlist starvation has been diagnosed by hand four separate times — Maven
and Gradle's argv order, the JS package managers' workspace selectors, a
rewriting proxy's prefix — and every time the evidence was buried in a stage
transcript: OpenCode's DeniedError dumps every bash rule pattern-unfiltered
(so the transcript "proves" the deny-all sentinel won), and the Claude/Qwen
guard's block message names only the one command it refused. The remedy
(`bashAllowlistExtra` / `bashAllowlistPrefix`) existed; the diagnosis did not.
`doctor` — the verb operators already reach for when a run misbehaves — knew
nothing about any of it.

## What changed

- **The deny log** — `<tasksDir>/runs/.deny-log.jsonl`
  (`packages/core/src/workflow/deny-log.ts`): one JSON object per denial
  (`ts`/`host`/`kind`/`stage`/`command`). Telemetry, never control plane —
  nothing reads it to decide anything, which is why one shared file serves
  every host (the per-host split the stage marker and evidence ledger need
  exists to protect a verdict input; a denial count has no verdict to
  corrupt). Writers are best-effort throughout and stop appending past a byte
  cap rather than growing without bound; readers take the last
  `DENY_LOG_MAX` parseable lines.
- **Writers** — the Claude/Qwen check-stage guard's allowlist block arm
  (`check-stage-guard.entry.mjs` via `hooks/src/deny.mjs`, the same
  bundle-local pattern as the evidence ledger), recording the RAW command —
  the shape the agent asked for is the shape the operator must allow. On
  OpenCode, a `permission.ask` observer in `impl.ts` records a `deny` on a
  bash permission of a session a live loop drives; observe-only
  (`output.status` is read, never written), and best-effort by construction —
  whether a hard `"*": deny` consults the hook is a host detail, so a quiet
  log costs nothing. Driver-run check admission is NOT a writer: design 24
  already reports those refusals (park preview, audit note, metrics).
- **Doctor** — both hosts aggregate the log per (kind, stage, command) with
  `suggestFor`, which derives the fix mechanically, no per-ecosystem table
  (the table is what went stale four times): if dropping the command's
  leading one or two tokens yields a command the stage's effective allowlist
  (manifest + platform extras + `bashAllowlistExtra`) already accepts, the
  denial is a rewriting proxy — suggest `bashAllowlistPrefix`, which widens
  nothing; otherwise suggest the narrowest mechanical `bashAllowlistExtra`
  glob (`<tool> <next> *`). `doctor fix` clears the reported log — telemetry
  acknowledged — alongside its other repairs.

## Sharp edges

- The suggestion is a REPORT, never an applied config change: an extra widens
  the stage's scope boundary (T2), so breadth stays the operator's call. The
  verb prose says so explicitly ("the config edit is the human's call, never
  yours").
- The prefix suggestion requires proof (the stripped command must already be
  allowed) — without globs to test against, only the extra-glob form is
  offered, because a prefix suggestion that cannot be verified would invite
  `bashAllowlistPrefix` entries that silently do nothing.
- `deny.mjs` and core's `deny-log.ts` share the filename and byte-cap
  constants by convention, asserted by `deny.test.mjs`'s shape test — a
  bundled hook cannot import core (same reason the marker carries
  `bashAllowlist`).
