English | [繁體中文](43-plan-sees-allowlist.zh-TW.md)

# 43 — PLAN sees the allowlist its discovered checks are judged by

**Status: implemented.**

## The problem

`checkDiscoveryBlock` told the plan author every discovered command "must be
on the VERIFY stage's own bash allowlist" — and never showed the list. PLAN
has no bash and no way to probe, so the commands were judged at admission
against globs the author never saw. Designs 24/29/38 all instrument the
failure AFTER the fact (park preview, deny log, refusal telemetry); the
cheapest fix point — write time — was the only uninstrumented one. The
canonical casualty: a monorepo plan naming `pnpm --filter web test` in a
perfectly readable shape, refused an iteration later behind one warning
line.

## What changed

- **`discoveryAllowlist` (core, `discovered-checks.ts`)** composes the
  consumer stage's effective list — manifest globs for the effective
  platform plus `bashAllowlistExtra` — and returns `undefined` whenever
  discovery is not in play (no discovering stage, or config/manifest checks
  preempt it). Kept beside `previewDiscoveredChecks` so it cannot drift from
  the arguments admission actually applies.
- **`checkDiscoveryBlock` renders it**: "That allowlist's patterns are:
  `npm test*` · … — a command is admitted only if it matches one", clamped
  by whole patterns (~2KB) with the elided count named, so a pathological
  `bashAllowlistExtra` cannot balloon every PLAN prompt.
- **`composePromptWithStats` threads it** as a new optional
  `composeStagePrompt` parameter; the hub's creator preview passes it
  explicitly, keeping the preview's byte-for-byte guarantee.

## Sharp edges

- **Bare shapes only.** The prefix twins (`bashAllowlistPrefix`) are
  deliberately omitted from the rendering: admission tolerates a
  proxy-prefixed command, but the shapes a plan should WRITE are the bare
  ones.
- **Config-less composes from the manifest alone** (default platform, no
  extras) — byte-identical to a default config, which is what keeps
  engine.test.ts's unset-knob pin and the hub preview guarantee both
  holding.
- **This is guidance, not a gate.** Admission (`admissibleChecks`) is
  unchanged; the block showing the list does not widen or narrow what runs.
