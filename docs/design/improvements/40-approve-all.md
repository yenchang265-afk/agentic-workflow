English | [繁體中文](40-approve-all.zh-TW.md)

# 40 — `approve --all` batches the task gate, and only the task gate

**Status: implemented.**

## The problem

`new` on a heavy idea drafts a slice set — N sibling drafts the human reviews
in one sitting — and then the gates make them type N approves (or answer N
follow-up asks): a bare `approve` over several candidates is deliberately an
ambiguity refusal, and nothing batched. The friction lands exactly where the
tool did its best work.

## What changed

- **`--all`** parses in `parseGateOptions` (so every host's parser inherits
  it — the bundled hooks forward dash-words untouched and needed no lesson),
  rides `approveAny` as its first routing check, and lands in
  **`approveAllTasks`**: every reviewed draft in `draft/`, priority order,
  tracking epics excluded, `approveTask` per child. On the fallback tool
  path it is `workflow_approve`'s `all` argument, documented under the same
  user-typed-only rule as `--auto-plan`.
- **Per-child refusals don't stop the walk**: the secret scan (or an
  unparseable file) refuses ITS draft, approved siblings stay approved, and
  the refusals ride the outcome message (clamped) with a `warning` variant —
  a partial batch is legible, never silently smaller.
- **`--auto-plan` composes** (`approve --all --auto-plan` arms every
  approved child), because both flags are the human's to type.

## Sharp edges

- **Task gate ONLY, by construction** — it lists `draft/`, nothing else. The
  plan and ship gates stay one-at-a-time forever: each needs a human to have
  READ something specific (a plan, a diff), and a batch form there approves
  documents nobody opened.
- **An id beside `--all` is refused** at parse (`--all takes no task id`),
  the same rule as two publish modes: there is no defensible reading.
- **No follow-up ask is armed.** The batch result carries no `gate`/`id`
  keys, which is exactly what keeps both hosts' task-gate follow-ups quiet —
  design 19's fail-safe arm (continue requires a known gate AND a string id)
  does the work; nothing new was added to the ask machinery.
