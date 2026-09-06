English | [繁體中文](74-qwen-bake-drift.zh-TW.md)

# 74 — A stale Qwen model bake is named at session start

**Status: implemented.**

## The problem

Qwen's `agent` tool takes no `model` argument, so `stageModels`/`agentModels`
are baked into the installed agent files at install time. Every nudge to
re-run the installer after a config change was prose; nothing compared the
config to the bytes on disk, so an edit to `stageModels` left every stage on
the old model with nothing failing — the exact silent-binding failure the
model-stamp hook exists to end on Claude, one host over.

## What changed

- **The installer records a bake** (`agents/.agentic-workflow-baked.json`):
  when, the bindings it baked, and `modelSubtrees` of the config it read —
  `agentModels` plus every `workflows.<kind>.stageModels`, nothing else, so
  an unrelated edit is not drift. No manifests needed to compare later.
- **The Qwen reconcile hook** (session start, host-gated on
  `conveysSpawnModel: false`) reads the record, projects the CURRENT raw
  config the same way, compares canonical JSON, and names the fix with the
  dialect's installer command. Fails toward silence: no record, or not
  Qwen, is not drift.

## Sharp edges

- **Twins, pinned.** `modelSubtrees` lives in the dependency-free installer
  and again in the bundled hook; the installer's is tested, the hook's is
  covered end-to-end by `reconcile.test.mjs` writing a record and a config.
- **Projection, not resolution.** Comparing resolved per-agent models would
  need the manifests a bundled hook cannot read; comparing the inputs that
  decide them needs nothing.
