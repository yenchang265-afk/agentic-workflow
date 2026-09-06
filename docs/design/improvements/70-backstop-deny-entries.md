English | [繁體中文](70-backstop-deny-entries.zh-TW.md)

# 70 — A write-backstop refusal is logged as one

**Status: implemented.**

## The problem

The deny log recorded what the stage ALLOWLIST refused, and the doctor
shaped a `bashAllowlistExtra` glob for each entry. The write backstops — a
push to a protected branch, a PR mutation, a mutating `find`, an ADO write —
refuse on both hosts and were not logged at all; and one of them WAS logged
wrongly: the Claude/Qwen guard folds the `find` rule into `commandAllowed`,
so `find . -delete` landed in the log as an allowlist denial and the doctor
prescribed `add "find . *" to bashAllowlistExtra` — advice that can never
work, because no glob reaches that rule.

## What changed

- **`source: "backstop"`** on `DenyEntry`; `parseDenyLine` accepts it,
  `aggregateDenials` counts `fromBackstop`, and a finding that is ALL
  backstop gets `NOT_THE_ALLOWLIST` instead of `suggestFor`'s glob;
  `formatDenyFindings` says `(a write backstop)`.
- **Claude/Qwen** (`check-stage-guard.entry.mjs`): `noteDeny` gains a
  `source` argument and every backstop `block` records one — the ADO write
  and scope refusals (the tool name stands in for the command), the gh
  mutation, the git push, and the allowlist refusal whose real cause is the
  `find` rule (`chainedFindMutation`, now exported by the hook allowlist as
  core's twin).
- **OpenCode** (`impl.ts`): `noteBackstop` appends a `source: "backstop"`
  entry before each of the four throws.
- Doctor prose on both CLI hosts and the hub panel no longer calls the log
  "the allowlist deny log".

## Sharp edges

- **A backstop entry must never suggest a glob.** That is the whole point;
  the mixed case (the same command refused by both) keeps the glob advice
  and says how many were backstop.
- **Best-effort, before the refusal, never awaited.** The throw or block is
  the decision; a failed append changes nothing.
