# Claims and liveness

Who is allowed to take a task, and how the loop decides whether the process
that claimed it is still alive. Every rule here fails in the same direction: a
wrong answer starts a SECOND drive on one `feature/<id>` branch, or wedges a
task no verb can free.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## Claim markers mean "a loop is driving this NOW"

A held `.claims/<id>` marker asserts a LIVE loop, nothing weaker — every gate
verb (`replan`/`abandon`/`remove`) refuses on it with that exact rationale. So
**every way a drive ends must release the marker**: `runStop` (any stage, not
just PLAN), `runPark`'s failure arms (including the one where the task is *gone*
from `queued/` — release `fresh ?? state.task`, never nest the release inside
`if (fresh)`), the OpenCode driveChain's stop/interrupt guard, and `onIdle`'s
error path all do, and any new exit path must too. It was once "kept for
recover" on stop instead, and the combination wedged cap-stopped tasks forever:
the orphan sweep skips a CLAIMED/BUILD body, so no verb could ever free them.
Two supporting invariants: drivers **restamp** the claim at every stage
boundary (`refreshClaimStamp`) so a live multi-stage run never reads stale to a
sweep; and any stale-marker takeover or release must go through the atomic
rename-aside helpers (`acquireOrSweepMarker` / `releaseMarkerIfStale`), never a
bare `rm`/`rmdir` + `mkdir` — the blind form let two sweepers both "win" one
task. Cross-process liveness for `recover` is judged by
`taskDrivenByStageMarker` (stage-marker deadline + writer pid), never by the
in-memory per-process driving map alone.

## A stale window is a proxy; the writer identity is the answer

`STALE_CLAIM_MINUTES` (and the stage-timeout-derived window doctor uses) never
measured anything about the claimer — they bound how long a HEALTHY stage may go
without durable progress, and were then read as "the claimer must be dead by
now". That is why a run which died before its first stage marker cost a human 15
minutes behind advice no one could act on: `stop` only ever stops the loop in the
CALLING process, so "stop it first" is unactionable against a process that is
already gone. So the claim stamp records `pid` + machine identity, and
`claimWriterLiveness` answers the question directly. Four things hold it up:

- **It fails CLOSED — the opposite of the host hooks.** They fail open because a
  false allow only restores older behaviour; here a false "dead" sweeps a live
  claim and starts a SECOND drive on one `feature/<id>` branch. No stamp, no
  pid, another machine, a garbled parse: all `"unknown"`, all keep the window.
- **`kill -0` failing is not death.** EPERM (alive, another user) exits non-zero
  exactly like ESRCH. `pidAlive` may not conclude death; `pidGone` must prove it
  positively, and every probe is self-validating — it has to see our OWN pid, or
  it proves nothing. This is why the two exist rather than one.
- **A pid needs its namespace.** Hostname alone does not separate sibling
  containers from one image, so the boot id joins it and any comparison missing
  either side is refused.
- **`releaseMarkerIfStale(…, 0)` is NOT the age-free release.** A zero window
  degrades `markerOlderThan` to a bare existence test, so the rename-aside's
  re-judge always says yes and a rival's brand-new claim is deleted — the exact
  double-sweep the rename-aside exists to stop. The age-free path is judged by
  writer IDENTITY (`releaseMarkerIfWriterDead` / `acquireOrSweepDeadWriter`),
  which re-judges soundly: a rival stamped its own live pid.

The stage marker stays the STRONGER witness and is checked first — it proves a
stage is running, where the stamp only says who took the claim. Only the
human-invoked verbs (`recover`, `doctor fix`) opt in; the unattended sweeps
(`claimFirst`, the startup sweep) keep the wall-clock rule, because no one is
waiting on them.

**Which way the reading cuts decides how much proof it needs.** `liveness.ts`
blesses the bare `pidAlive` probe only for callers that RELAX a guard on a false
reading — core's marker readers do (a false "dead" merely lets `recover` through).
The Claude/Qwen hook probe is the opposite: there "alive" keeps the deadline
starve, so a false one blocks Bash and Write repo-wide addressed to nobody — the
wedge `dead-marker.test.mjs` shipped to end, reopened one environment over by
sibling containers sharing a bind-mounted repo. So `markerWriterAlive` proves
aliveness or answers no: the marker's `machine` stamp must name THIS machine
(`writeStageMarker` stamps `machineIdSync()`; an older server's absent stamp is
not provably local), and the probe must see our OWN pid first or it proves
nothing about anyone else's. `liveMarker` is the single expression of the rule —
stated in one guard, `check-evidence` never got it and `decideSpawnGuard` claimed
it in prose while implementing something weaker.
