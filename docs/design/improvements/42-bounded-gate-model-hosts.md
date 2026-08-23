English | [繁體中文](42-bounded-gate-model-hosts.zh-TW.md)

# 42 — A gate move cannot hang or lose its envelope on the model hosts

**Status: implemented.**

## The problem

Design 21 bounded the gate shell on OpenCode only — and the hang class is
host-agnostic. On Claude Code / Qwen, a `workflow_approve` or
`workflow_ship` on a slow tree (WSL `/mnt/c`, where PR #266's hang actually
happened) left the MCP call `running` forever with the orchestrator's turn
wedged behind it. And one seam deeper, the gate HOOK had the same window
with a worse failure: Claude Code kills a command hook at its own deadline
(60s default) and drops the whole envelope — the GateResult AND the
`decision: "block"` — so a slow gate (cold node start + a commit on a
`/mnt/c` tree) ended as a silent double-dispatch: the move had landed, the
block was lost, and the model ran the verb again via MCP.

## What changed

- **The MCP server's `gateCtx` hands core a bounded shell**: every command
  gets a 60s cap through the shim's own `.timeout`, which (unlike
  OpenCode's race fallback) kills the child and resolves exit 124 —
  `timeout(1)`'s convention, which core reads as an ordinary failed
  command. The move still reports; only best-effort bookkeeping is skipped.
- **The gate hook's `spawnSync` gets a 50s deadline** — 10s inside the
  host's own hook kill, so the envelope stays ours. `decideGateOutcome`
  gains a distinct ETIMEDOUT arm that BLOCKS (fail closed): a timeout is
  not a crash — the CLI was mid-flight, so the move may already have
  landed, and failing open invites the double-move. The block names what to
  check (`status`, the backlog folders) before retrying.
- Qwen's bundled `gate-command.mjs` regenerated from the same source.

## Sharp edges

- **The plain `sh` stays unbounded.** Checkpoint commits, worktree setup and
  `runChecks` legitimately run long and carry their own regime — the cap is
  wired in `gateCtx()` alone, same scoping rule as design 21.
- **60s is generous on purpose**: the slowest legitimate gate command is the
  ship's `git push` / `gh pr create`, and cutting one short costs a caveated
  ship a human can finish by hand — where NOT capping cost a call that never
  returned.
- **The timeout arm must stay ahead of the fail-open arm** in
  `decideGateOutcome`: the generic spawn-error pass exists for "node never
  ran", whose premise a timeout does not share.
