English | [繁體中文](73-per-repo-user-config.zh-TW.md)

# 73 — Per-repo sections in the user-scope config

**Status: implemented.**

## The problem

The user-scope config applied to every checkout alike. Two repos wanting
different `stageModels`, a `notifyCommand` for one but not the other, or a
`worktreesDir` on a different disk had one option: commit the difference
into each repo's `.agentic-workflow.json` — which the repo layer cannot
carry for the shell-bearing and allowlist keys by design.

## What changed

- **`repos`** in the user layer: `{ "<absolute path or basename>": { …any
  config keys… } }`. `userRepoOverrides` matches an exact absolute path
  (after `path.resolve`, `~` expanded) before a basename — deterministic,
  never "whichever key came first" — and `applyUserRepoOverrides` folds the
  section over the global user keys and drops `repos` itself. Precedence:
  global user keys < user `repos.<match>` < the repo file.
- **Every reader honours it**: `loadConfigWith`, the zod-free
  `readRawConfigLayers` (which feeds the model-binding hook — a per-repo
  `stageModels` the loop honoured but the hook did not would run every spawn
  on the wrong model with nothing failing), the hub's config view and
  provenance, and the Qwen installer's own merge.
- **Declared**: `RepoOverrideSchema` is the base object made partial, so a
  section is validated, completed by the JSON Schema and cannot nest another
  `repos`; a `repos` key in a REPO file is dropped and named (family
  `userOnly`) — honouring it from a clone would let a repo re-grant itself a
  shell-bearing key under a wrapper.
- **`effectiveConfigReport.matchedRepoSection`** names the key that
  applied; both hosts' `doctor config` say so.

## Sharp edges

- **A section overrides, never defaults.** The merge runs on raw layers
  before parsing; the schema's defaults apply once, to the combined view.
- **Absolute beats basename.** A basename is convenient and ambiguous; the
  full path is what a human wrote deliberately.
