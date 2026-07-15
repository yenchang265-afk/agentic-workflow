# Sitters (experimental)

Four opt-in kinds that watch a hosted surface and drive a fix, always
leaving the terminal call — merge, approve, close — to a human.
`engineering` (the reference kind — PLAN/BUILD → VERIFY → REVIEW) is
documented in [architecture.md](architecture.md) and
[`docs/loops/engineering.md`](loops/engineering.md); this file covers only
`pr-sitter`, `review-sitter`, `dep-sitter`, and `main-sitter`.

> **All four sitters are experimental** — their manifests, config keys, and
> defaults may still change between releases. `engineering` is the stable,
> default-on kind.

Each sitter's own architecture — stage pipeline, mermaid diagram, authority
limits, and `.agentic-loop.json` config keys — now lives in its own file:

- [`docs/loops/pr-sitter.md`](loops/pr-sitter.md)
- [`docs/loops/review-sitter.md`](loops/review-sitter.md)
- [`docs/loops/dep-sitter.md`](loops/dep-sitter.md)
- [`docs/loops/main-sitter.md`](loops/main-sitter.md)

## What they have in common

Each sitter follows the same shape: a **check** stage decides whether there
is claimable work, one or more **work** stages run behind git worktree
isolation, and a terminal **publish** stage writes through a narrow,
manifest-declared bash/platform allowlist. Every kind is opt-in
(`loops.<kind>.enabled`), resolves GitHub vs. Azure DevOps from the global
`codePlatform` (or its own `loops.<kind>.codePlatform` override) at wiring
time, and treats whatever diff/comment/CI text it reads as **untrusted
input** — never instructions. `loops.<kind>.trigger` controls how a watching
host schedules claims for that kind (OpenCode `watch` mode only). See
[`docs/design/threat-model.md`](design/threat-model.md) for the full
security posture, and [`configuration.md`](configuration.md#code-platform-codeplatform--ado)
for the ADO platform mechanics (PAT, custom headers, the write-backstop hook)
and [`configuration.md`](configuration.md#loop-kinds-loops) for the full
`loops.<kind>` key reference.
