English | [繁體中文](55-show-verb.zh-TW.md)

# 55 — `show <id>`: one task, read the way the gates read it

**Status: implemented.**

## The problem

`status` is a roll-up: counts per folder and the tasks waiting on a verb. To
learn about ONE task — is there a plan, why was the last one rejected, what
did the stopped run leave behind, is a claim held, what does the audit trail
say — the CLI hosts had `cat`, and `cat` is the wrong reader: the facts the
gates act on are derived by stamped-audit-line parsers (`extractReplanReason`,
`extractStopContext`, `priorRunFor`, `isClaimable`, `wasInterrupted`), and a
human reading the raw file reads quotations as records. The hub's task drawer
had the projection; the terminal the loop is driven from did not.

## What changed

- **`describeTask` / `formatTaskDescription`** (`task/describe.ts`) — one pure
  projection (`TaskDescription`) and one renderer, shared by both hosts. Every
  field comes from the parser the corresponding verb trusts, so `show` cannot
  disagree with what `approve`, `replan`, `recover` or a claim walk will do.
  Optional keys are omitted, never empty. The audit trail is capped at
  `SHOWN_NOTES` newest, older ones counted.
- **`extractAuditNotes` moved to core** from the hub (which re-exports it), so
  the timeline the drawer shows and the one `show` prints are one parser.
- **`showTask(ctx, id)`** in `workflow/gate.ts`: resolves the id like every
  verb (handles, ambiguity refused with candidates, an unparseable file named),
  reads the folder's claim markers and the snapshot list, and returns the
  projection as `data` with the rendered lines as `message`. Moves nothing,
  commits nothing.
- **Both hosts**: `show <id>` on OpenCode (the head line toasted, the report
  replaces the markdown so the model relays it); on Claude/Qwen the gate hook
  dispatches `gate show` and blocks the turn with the report — read-only, but
  deterministic, and no model turn improves on it — with `workflow_show` as the
  tool form.

## Sharp edges

- **A snapshot beside a claimable body is not an interruption** — the same
  rule `summarizeBacklog` applies (design 53), restated here so the two views
  agree.
- **`abandonedFrom` is display data.** It is parsed only for a task in
  `abandoned/` and never drives a move (see design 56).
- **The hook blocks on a read.** Continuing the turn would spend a model turn
  re-reading a file the report already summarises; the block IS the answer.
