# Check stages and verdicts

What a check stage is promised, what its passes may be asked for, and how a
verdict is admitted or refused. The through-line: never manufacture a guarantee
no pass actually earned.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## A focused pass's contract must match the passes that will run

A check stage's prompt is composed ONCE, then each pass gets `passFocusBlock`
appended. So `verdictContractBlock`'s mode has to be the EFFECTIVE one
(`stagePasses`), never the manifest's — and every pass regime needs its own
branch. Lens passes rendered the single-pass contract for a while: each lens was
told "MUST carry an `axes` array covering all 5 axes … a call missing an axis is
REJECTED" directly above "focus exclusively on `<lens>`". The two cannot both be
satisfied, and the threat was empty (`passAxes` returns `undefined` for a lens,
so nothing rejected). Both ways out were bad: obey the contract and the pass
invents axis verdicts it did no work for — and since passes merge worst-wins, a
fabricated "correctness: PASS" becomes the STAGE's correctness verdict, which is
worse than no coverage because it manufactures the guarantee; obey the suffix and
coverage silently vanishes. When adding a pass mode, add its contract branch and
point it at the line `passFocusBlock` actually emits.

Coverage enforcement follows the same rule — enforce what the passes can
actually satisfy. `enforcesAxisCoverage` is the single seam both hosts ask:
per-axis fan-out always, lenses only when they between them name every required
axis, single passes never (per-pass admission already covers it). Do not gate it
on `pass.mode === "axis"` inline again; a lens set that spans the axes is
enforceable and a lens set that cannot is not, and only that predicate knows the
difference.

`verdictContractBlock` is therefore the SSOT for the verdict PAYLOAD, and the
check personas (`prompts/agents/workflow-{verify,review}/body.md`) point at it
rather than restating it. They used to carry their own copy — the field list,
the rejection rules, the evidence clause, and all three pass regimes — beside a
composed block that renders only the regime actually in force, so the persona's
copy could contradict the live contract while looking authoritative, which is
the failure the section above describes one layer up. A persona keeps only what
the block cannot know: the host's tool name, OpenCode's transcript echo line,
the prose deliverables, and the FAIL/ERROR distinction its own stage draws.
Restating the payload there is a regression, not a helpful reminder.

## A rejected verdict is not a missing one

`admitVerdict` refusing a call means the channel WORKED and the shape was wrong.
Treating the two as one thing cost a whole class of run: a REVIEW that failed but
phrased its FAIL unadmittably (no critical/important finding, an axis short) left
`pending`/`recordedVerdicts` empty, so the host re-fired the same review — and the
second refusal became ERROR, which `review.onError` turns into a stop. The visible
symptom is "another REVIEW ran and we never went back to BUILD": a review with
real findings ends the run instead of feeding the rebuild its `onFail` arm exists
for.

So both hosts keep the refused RECORD (`RejectedVerdict`), not a boolean, and once
the one retry is spent `rejectedFallback` records the stage **as it declared** —
FAIL stays FAIL, so `onFail` fires BUILD with the findings and the rejection
message rides in `reason` so the next BUILD knows both. Two halves of that are
load-bearing and must not be "simplified":

- **An effective PASS is never salvaged.** Every rejection a PASS can draw exists
  because the PASS was not earned; laundering it ships unreviewed work, which is
  worse than the ERROR stop. `rejectedFallback` returns null there, and the caller
  keeps its ERROR.
- **The two ERROR reasons stay distinct** (`noAdmissibleVerdictReason`). "The
  verdict channel is unreachable — fix the plugin wiring" was reported for
  refusals too, sending operators after an MCP channel that had just answered
  twice.

## A stage pass's identity is its session (OpenCode)

Every per-pass table in the OpenCode driver — `recordedVerdicts`,
`axisRequirement`, `observedEvidence`, `recordedBlocked`, `driftNoted` — is keyed
by **session id alone**, and check stages run as `subtask: true` commands whose
verdict walks *up* the parent chain to whatever session is registered. That is
why passes were serial: sharing one id, being "the pass that fired last" is the
only identity a verdict has, so two in flight would cross-admit each other's
verdicts, wipe each other's evidence, and `takeVerdictRecord` (which deletes on
read) would let the first finisher steal a merged blob.

So concurrency is bought by giving each pass its own session
(`workflows.<kind>.stageConcurrency` — unset, a per-axis fan-out runs all its
passes at once and everything else runs one at a time), NOT by re-keying those
maps.
Two consequences any change here must preserve:

- **Never pass a `directory` to `session.create`.** That is what plan 01 ruled
  out: it boots a second app instance with no plugin, so `workflow_verdict` does
  not exist there. A sibling session in the same directory is fine, and is the
  whole mechanism.
- **A pass session is not a loop.** It is registered in the workflow store so the
  pass's verdict resolves to it, which means every "is a loop live / which
  session drives this task" query must skip it — that is what `passOf` marks, and
  why `findSessionDriving` and `onInterrupt` both consult it. `halted` is always
  tested against the DRIVING session; a user's ESC never lands on a pass.

Anything shared by the whole run rather than by one pass needs a lock now that
passes overlap: `appendRunLog` (append) and `flushMetrics` (read-modify-write)
both go through `withLock(runLocks, …)`. Adding another per-run writer means
adding it there too.
