English | [繁體中文](README.zh-TW.md)

# Loop kinds

Each kind is a single agentic loop. Each file below is that kind's full
picture — architecture (stage pipeline, mermaid diagram, config keys), how
to enable it, its command surface, and 1-2 worked examples.

- [**engineering**](engineering.md) — PLAN (parks at human gate) → BUILD → VERIFY → REVIEW over `docs/tasks/` backlog
- [**pr-sitter**](pr-sitter.md) — TRIAGE → FIX → VERIFY → PUBLISH over open pull requests
- [**review-sitter**](review-sitter.md) — FETCH → ASSESS → PUBLISH over pull requests where your review is requested
- [**dep-sitter**](dep-sitter.md) — SCAN → UPGRADE → VERIFY → PUBLISH over vulnerable/outdated dependencies
- [**main-sitter**](main-sitter.md) — DIAGNOSE → REMEDY → VERIFY → PUBLISH over red default-branch CI

For the manifest format and authoring a new kind, see [`packages/core/loops/README.md`](../../packages/core/loops/README.md).
