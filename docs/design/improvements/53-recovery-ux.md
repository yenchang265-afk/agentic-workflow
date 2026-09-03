English | [繁體中文](53-recovery-ux.zh-TW.md)

# 53 — Recovery sees every crash, and needs no id when there is one

**Status: implemented.**

## The problem

`status`'s `interrupted:` list — and the `recover <id>` hint it renders —
came from `wasInterrupted`, which reads the task body's BUILD markers: a
`> BUILD started` with no matching `> BUILD finished`. That witnesses a
BUILD crash and nothing else. A run that died at VERIFY or REVIEW left a
finished BUILD pair, so it read as "not interrupted": the task sat in
`in-progress/` with a stage snapshot on disk — the exact-stage oracle
`recover` resumes from (design 02) — and nothing on either host named it.
And `recover` demanded an id on both hosts even when there was exactly one
task to recover.

## What changed

- **The snapshot is a second interruption oracle.** `summarizeBacklog` takes
  `snapshotIds` (`listSnapshotIds`, the `runs/<id>.state.json` files) and
  lists an in-progress task as interrupted when its body says so OR a
  snapshot names it — excluding a still-claimable body, where a snapshot is
  a stale leftover and `recover` would refuse. Both hosts' status and the
  hub's backlog route pass it.
- **`soleInterrupted(summary)`** is the one task an id-less `recover` may
  mean. Both hosts accept the id-less form (`workflow_recover`'s `id` is
  optional; the OpenCode verb's usage says `recover [id]`): exactly one
  interrupted task resumes; several is refused with the list; none is
  usage. Every argument hint and doc line says `[id]`.

## Sharp edges

- **A snapshot beside a claimable body is not an interruption.** It is what
  a stale run left, and `recover` refuses a never-started task — listing it
  would name a verb that cannot act.
- **Optional parameter, unchanged callers.** `summarizeBacklog`'s third
  argument defaults to `[]`, so a caller that predates it is byte-identical.
- **Ambiguity is refused, never guessed** — the same rule the id-less
  `approve` follows.
