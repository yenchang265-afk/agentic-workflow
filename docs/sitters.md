English | [繁體中文](sitters.zh-TW.md)

# Sitters

Four kinds that watch a hosted surface and drive a fix, always
leaving the terminal call — merge, approve, close — to a human.
`engineering` (the reference kind — PLAN/BUILD → VERIFY → REVIEW) is
documented in [architecture.md](architecture.md) and
[`docs/workflows/engineering.md`](workflows/engineering.md); this file covers only
`pr-sitter`, `review-sitter`, `dep-sitter`, and `main-sitter`.

> **`pr-sitter` and `review-sitter` are stable** — their manifests, config
> keys, and defaults are settled, and changes follow the same compatibility
> bar as `engineering`, the default-on kind.
>
> **`dep-sitter` and `main-sitter` are still experimental** — their manifests,
> config keys, and defaults may still change between releases.

Each sitter's own architecture — stage pipeline, mermaid diagram, authority
limits, and `.agentic-workflow.json` config keys — now lives in its own file:

- [`docs/workflows/pr-sitter.md`](workflows/pr-sitter.md)
- [`docs/workflows/review-sitter.md`](workflows/review-sitter.md)
- [`docs/workflows/dep-sitter.md`](workflows/dep-sitter.md)
- [`docs/workflows/main-sitter.md`](workflows/main-sitter.md)

## What they have in common

Each sitter follows the same shape: a **check** stage decides whether there
is claimable work, one or more **work** stages run behind git worktree
isolation, and a terminal **publish** stage writes through a narrow,
manifest-declared bash/platform allowlist. `pr-sitter` and `review-sitter`
run unless disabled; `dep-sitter` and `main-sitter` are opt-in (all four via
`workflows.<kind>.enabled`). Each resolves GitHub vs. Azure DevOps from the global
`codePlatform` (or its own `workflows.<kind>.codePlatform` override) at wiring
time, and treats whatever diff/comment/CI text it reads as **untrusted
input** — never instructions. `workflows.<kind>.trigger` controls how a watching
host schedules claims for that kind (OpenCode `watch` mode only). See
[`docs/design/threat-model.md`](design/threat-model.md) for the full
security posture, and [`configuration.md`](configuration.md#code-platform-codeplatform--ado)
for the ADO platform mechanics (PAT, custom headers, the write-backstop hook)
and [`configuration.md`](configuration.md#workflow-kinds-workflows) for the full
`workflows.<kind>` key reference.
