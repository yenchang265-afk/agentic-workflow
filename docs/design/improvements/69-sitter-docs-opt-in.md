English | [繁體中文](69-sitter-docs-opt-in.zh-TW.md)

# 69 — Every documented sitter section carries `enabled`, by test

**Status: implemented.**

## The problem

Every sitter is opt-in (`enabledWorkflowKinds`: a non-default kind runs only
with `enabled: true`, and a section without it is warned about as inert).
The docs drifted from that twice: a quick-start whose sitter section lacked
the key configured a sitter that never runs. The 2026-08-23 finding was
repaired, but a `prBase` example in `docs/configuration.md` (and its zh-TW
twin) still showed `"dep-sitter": { "prBase": "main" }` alone, and the Qwen
page's command table never said any sitter was opt-in.

## What changed

- The two examples gain `"enabled": true`; the Qwen page marks all four
  sitters `(experimental, opt-in)` and states the rule once, pointing at
  `docs/sitters.md` for the knobs.
- **`scripts/docs-sitter-enabled.test.mjs`** parses every fenced ```json
  block across the doc set and fails on a `workflows.<opt-in kind>` section
  without `enabled` — reading `EXPERIMENTAL_KINDS` off core's built dist, so
  a new kind is covered the day it is added.

## Sharp edges

- **Unparseable blocks are skipped.** A fragment with `<placeholders>` is
  not a config example; only what `JSON.parse` accepts is judged.
