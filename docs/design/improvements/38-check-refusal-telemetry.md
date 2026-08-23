English | [繁體中文](38-check-refusal-telemetry.zh-TW.md)

# 38 — Check-admission refusals join the deny log

**Status: implemented.**

## The problem

Design 29 gave allowlist starvation a telemetry channel — but only for the
AGENT seam. A plan-named discovered check the stage's admission refused was
warn-only: a line in a log nobody keeps, plus a `checksRefused` metric that
actually counted `warnings.length` — parse issues, admission refusals, and
missing binaries conflated into one number. So the exact failure design 29
existed to end (VERIFY silently running fewer checks than the PLAN promised,
diagnosed by transcript archaeology) still had a silent seam: `doctor`'s one
telemetry view covered agent denials and nothing else.

## What changed

- **`ResolvedChecks` gains `refused`** — the admission rejections alone,
  structured, each `RejectedCheck` now carrying the refused `command`
  verbatim. Parse issues and missing binaries stay in `warnings`: those are
  plan-shape and environment facts no allowlist change answers.
- **Both hosts feed the deny log** at their `resolveStageChecks` call sites:
  one entry per refused command with the new `source: "check"` field. An
  absent source reads as `"agent"`, so every pre-existing entry and writer
  is unchanged.
- **Doctor's aggregation says where a denial came from**: `DenyFinding`
  gains `fromChecks`, and the report line renders `(a plan-discovered
  check)` / `(N of these from plan-discovered checks)` — the operator's
  mental model is "denials come from the agent", and a check refusal is the
  one that starves VERIFY behind a plan that looked fine at the gate.
  `suggestFor` is unchanged and applies as-is: the same
  `bashAllowlistExtra`/`bashAllowlistPrefix` remedies admit a discovered
  command, because admission evaluates the same effective globs.
- **`checksRefused` is honest**: both hosts' metrics samples now count
  `refused.length`, so the hub's discovery stats stop inflating refusals
  with parse noise and absent binaries (those remain visible in `detail`).

## Sharp edges

- Only admission refusals write entries — a missing binary is an environment
  fact, and logging it as a "denial" would send operators editing allowlists
  that were never the problem.
- The deny log write is the same best-effort `appendDenyEntry` contract:
  telemetry must never change what admission does with the command.
- `doctor fix` clears check-sourced entries with the rest — one log, one
  lifecycle.
