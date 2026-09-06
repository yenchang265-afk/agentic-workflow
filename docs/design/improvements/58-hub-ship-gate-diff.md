English | [繁體中文](58-hub-ship-gate-diff.zh-TW.md)

# 58 — The hub's ship gate shows the diff it approves

**Status: implemented.**

## The problem

Designs 33 and 34 gave the CLI ship gate a verified `git diff` view and the
REVIEW stage's non-blocking `suggestion` findings. The hub's ship button —
the one surface where the gate is a mouse click — approved a diff it had
only ever shown the SIZE of: the queue row rendered the done note's
diffstat and branch, and nothing rendered the diff. The suggestions were
worse off: `runDone` writes `> Review suggestions (N) — …` BEFORE the done
note so the done note stays the trail's newest line, and the queue's
`lastEvent` shows exactly that newest line — so the one note written for
this gate was the one this gate could not see.

## What changed

- **`extractRunSuggestions`** (`task/store.ts`) parses the suggestions note
  off the stamped-line rules, anchored to the LAST completed run: a run that
  ends with no suggestions writes no note, so an older run's line must not
  be shown against a newer diff. `runDone` now builds the note from
  `SUGGESTIONS_MARKER`, pinning writer and parser together.
- **`diffText`** (`workflow/git.ts`): `git diff <base>...<branch> --` by ref
  from the main checkout, like `diffShortstat`, capped at `maxLines` with
  the true line count and a `truncated` flag.
- **`GET /api/review/:status/:id/diff`**: branch and base come off the done
  note — the same fields the ship pushes — never from the request, so the
  route cannot be pointed at an arbitrary ref pair; the base falls back to
  the repo's default branch exactly as the ship does. Capped by
  `workflows.<kind>.maxDiffLines` (the review sitter's knob; one number, not
  two), else `DEFAULT_MAX_DIFF_LINES`.
- **The queue row** carries `suggestions` and a Diff disclosure that fetches
  on open only — the queue re-fetches on every SSE tick and a diff is
  unbounded — and names the command for the rest when truncated.

## Sharp edges

- **Never split the suggestions text back into findings.** A finding's
  detail may carry semicolons; the note is one clamped line and is shown as
  one.
- **The diff is evidence, not a second review.** The hub still never runs a
  stage; it shows what the run recorded and what git says about it.
