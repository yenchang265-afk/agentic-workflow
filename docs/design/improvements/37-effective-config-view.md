English | [繁體中文](37-effective-config-view.zh-TW.md)

# 37 — One seam answers "what config is in force, and why not mine"

**Status: implemented.**

## The problem

The runtime drops user-layer-only keys from the repo config (shell-bearing
keys, nested `workflows.<kind>.stageChecks`/`scannerCommand`, the ADO
destination/credentials) — but each surface told a different story. The
drops lived as three private async functions inside `loadConfigWith`, warned
once at load into a log nobody keeps; **no CLI surface printed the resolved
config at all** (`kinds` printed file paths only); the hub's "effective" view
merged the RAW layers, so a repo-layer `stageChecks` showed as in effect when
the loop ignores it; and `readRawConfigLayers` — the reader every bundled
hook trusts — stripped only the TOP-LEVEL shell keys while its own doc
claimed full parity.

## What changed

- **One pure seam** in `config-layers.ts`: `droppedRepoKeys(repoRaw)` (dotted
  paths + family) and `sanitizeRepoLayer(repoRaw)`. `loadConfigWith`'s
  warnings, the hub's effective view, `readRawConfigLayers`, and the doctor
  report all read the same list — a key warned about at load can never show
  as "in effect" on another surface. The three drop functions are gone;
  their warning texts are preserved verbatim, worded per family.
- **`readRawConfigLayers` now applies the FULL drop set** — closing the gap
  where a repo-layer nested `stageChecks` or `ado.organization` reached the
  hooks that trust it.
- **`doctor config`** (both hosts; `workflow_doctor({config: true})` on the
  MCP host) returns `effectiveConfigReport`: the layer file paths (the user
  path only when the file exists), the dropped repo keys, and the config the
  process is ACTUALLY running with — the host's already-loaded object, never
  a re-derived merge — masked by `maskConfigSecrets` (key-name based:
  pat/token/secret/password/api-key at any depth).
- **The hub's effective view is honest**: `getConfig` merges the sanitized
  repo layer (effective, provenance, and issues all reflect runtime), and
  the response's new `droppedRepoKeys` renders as a "Set here, ignored at
  runtime" section naming the move-to-user-config fix.

## Sharp edges

- The per-layer `raw` view stays UNsanitized on purpose: it shows the file;
  `droppedRepoKeys` is what says which of its keys the runtime discards.
- `effective` is display-only everywhere, and masked before it leaves —
  never write it back (the hub header's rule 2 already forbids it; the
  doctor report inherits the same rule by carrying `[REDACTED]` values).
- `maskConfigSecrets` is deliberately broader than today's one secret field:
  a future credential key is masked the day it is added.
