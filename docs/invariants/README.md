# Engineering invariants

The reasoning behind the rules indexed in [`AGENTS.md`](../../AGENTS.md) →
**Engineering invariants**. That index is loaded on every session of every host
and carries each constraint in one line; these files carry the *why* — the
failure the rule prevents, the asymmetry it is deliberately built on, and what a
plausible-looking "simplification" of it would cost.

Open the file for the subsystem you are editing. A rule you are about to change,
work around, or delete is one whose file you read first.

| File | Governs | Open it when editing |
|---|---|---|
| [claims-and-liveness.md](claims-and-liveness.md) | Who holds a task, and whether the holder is alive | `claim-marker.ts`, `liveness.ts`, a marker sweep, `recover`, `doctor fix` |
| [git-isolation.md](git-isolation.md) | What `state.git` means, where a run's tree is left | `ensureIsolation`, `teardownIsolation`, `checkoutBranch`, `persist.ts` |
| [checks-and-verdicts.md](checks-and-verdicts.md) | What a check stage is promised and what it may record | `verdictContractBlock`, `passFocusBlock`, `admitVerdict`, `stagePasses`, the check personas |
| [bash-allowlist-and-config.md](bash-allowlist-and-config.md) | Which commands a stage can run, and which layer may widen that | `workflow.json` allowlists, `allowlistFor`, `commandAllowed`, `admissibleChecks`, a new config key |
| [host-protocol.md](host-protocol.md) | How the three hosts drive the loop, spawn, ask, and bind models | `prompts/verbs/`, a command router, the gate hooks, the MCP gate tools, `onIdle` |
| [task-files-and-audit.md](task-files-and-audit.md) | The task file as ledger — schema, id parsing, note shape | `TaskFrontmatterSchema`, `store.ts`, `plan-section.ts`, `rejectAny`, `appendNote` |
| [driver-hooks-and-tools.md](driver-hooks-and-tools.md) | Halting, publishing, and the silent ways a turn dies | `driveChain`, `impl.ts`, a hook entry point, `hooks.json`, a plugin tool |

These are contributor- and agent-facing engineering notes rather than user
documentation, so they are English-only — the same footing as
[`../ideas/`](../ideas/). The user-facing docs listed in
[`../README.md`](../README.md) keep their zh-TW translations.

Adding a rule means adding **both halves**: the one-line constraint to the
`AGENTS.md` index, and its reasoning here. See `AGENTS.md` → Maintaining these
rules for when a rule earns its place at all.
