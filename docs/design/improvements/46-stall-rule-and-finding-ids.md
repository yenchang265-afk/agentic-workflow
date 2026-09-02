English | [繁體中文](46-stall-rule-and-finding-ids.zh-TW.md)

# 46 — The stall rule, and findings that know they are repeats

**Status: implemented.**

## The problem

The only bound on a run was `maxIterations`, judged in one place —
`advance`'s `countIteration` arm — by COUNT alone. The attempts ledger
(design 25) recorded what each iteration failed on, but only for the prompts
to read: both stage prompts asked the model to "name a recurrence" and "not
repeat a fix that already failed", and nothing compared two attempts. So a
VERIFY that failed on the same two criteria and the same critical finding
three times running burned every iteration before the cap message finally
said "the plan is likely wrong" — a conclusion the second identical pass
already proved, at the price of a full BUILD + VERIFY (+ REVIEW) that no one
asked for.

The rebuild's feedback block had the same blind spot one layer down.
`AxisFinding` carried no identity, so `verdictFeedbackBlock` re-emitted every
blocking finding verbatim each iteration: BUILD could not say "addressed",
REVIEW could not say "still open", and a finding that came back after a fix
read exactly like news.

## What changed

- **Stable finding ids.** `findingId(axis, finding)` is an FNV-1a hash of
  axis + severity + the normalized `location` (falling back to the detail
  text only for a location-less finding). A located finding keeps its id
  across rewordings — the model rephrases; the `file:line` does not. The
  feedback block renders every blocking finding as `… (finding a3f1c9d2)`,
  and one whose id the ledger already holds for this stage as
  `(finding a3f1c9d2 — REPEAT, also raised in iteration N: the previous fix
  did not resolve it)`.
- **A structural fingerprint per counted attempt.** `failureFingerprint`
  hashes the failed criteria set and the sorted blocking finding ids —
  never the reason — and `withAttempt` stores it (with the ids) on the
  `AttemptRecord`; `persist.ts` declares both so a resumed run keeps them.
- **`stallAfter` on a counted fire.** Once this failure plus the ledger's
  trailing identical attempts on the same stage reach N, `advance` stops
  with `stallMessage` (`{stallAfter}`/`{maxIterations}` interpolate; falls
  back to `capMessage`). Engineering sets `stallAfter: 2` on VERIFY and
  REVIEW. The cap is checked first and always wins.

## Sharp edges

- **A reason-only FAIL never stalls.** It has no fingerprint. A false stall
  ends a run that might have converged; a missed one costs exactly what the
  cap costs today. Absence of structure reads as "different".
- **The line number stays in the id.** Dropping it would fold two different
  critical findings in one file into one id, and a false "repeat" is the
  reading that ends a run — so the id errs toward "new".
- **Trailing means trailing on THIS stage.** VERIFY, REVIEW, VERIFY with the
  two VERIFY failures alike is a stall — a regression of the same finding
  after a review-driven rebuild is the two fixes fighting, which is the plan's
  problem to settle.
- **Opt-in per arm, and it requires `countIteration`.** A kind that declares
  no `stallAfter` is byte-identical to before; the manifest schema refuses
  the field on an uncounted fire.
