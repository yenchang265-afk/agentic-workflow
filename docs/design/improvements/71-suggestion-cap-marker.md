English | [繁體中文](71-suggestion-cap-marker.zh-TW.md)

# 71 — The suggestion cap says what it cut

**Status: implemented.**

## The problem

`suggestionFindings` caps REVIEW's non-blocking findings at ten and used to
return early with no count, so the done note's `Review suggestions (N)` was
the CAPPED number and read as the truth; the OpenCode toast and the Claude
ship descriptor repeated it. An eleventh suggestion vanished without a trace
anywhere the human looks.

## What changed

- **`suggestionsElided(record)`** counts what the cap dropped;
  `advance`'s done action carries `suggestionsElided`, `TerminalReport`
  forwards it.
- **The audit note** appends ` (+K more not shown)` INSIDE its free-text
  half, after the clamped list, so `extractRunSuggestions`' `(N)` stays the
  rendered count and its regex still matches; the hub's review row shows the
  marker for free.
- **The OpenCode toast** and **the Claude ship descriptor** name the
  remainder (`+K more past the cap`), and the descriptor carries the number.

## Sharp edges

- **The cap stands.** Ten is what a ship gate reads; the marker tells the
  human the metrics sidecar has the rest, it does not widen the list.
- **Never in the rebuild seam.** Suggestions and their remainder are for the
  human at the diff review only.
