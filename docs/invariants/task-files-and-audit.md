# Task files and the audit trail

The task file IS the ledger. These rules cover its frontmatter schema, how ids
and reasons are parsed out of what a human typed, and the shape of an audit
note — which several parsers depend on and no error announces breaking.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## A slice set's link is `epic:`, and it has to be in the schema

`new` splits a heavy idea into sibling child drafts plus a `type: epic` tracker,
so the gates routinely face N tasks where they were designed for one. Two things
they need from a set — which slices to offer when a bare `approve` is ambiguous,
and which slice to name next once one is queued — are answerable only from a
STRUCTURED link, so each child carries `epic: <epic-id>`.

- **Not the body's `Part of epic:` line.** That is LLM-authored prose that drifts
  with the prompt writing it; deriving the walk from it is `message`-derivation
  by another name, the thing `taskGateId` exists to refuse. The line stays as the
  human-readable half, and nothing reads it.
- **Not "every un-approved draft" either.** A stranger's draft named as "the next
  slice of this set" is a guess, and the gates do not guess. `epicSiblings`
  returns `[]` for a task with no epic; a caller with nothing to go on renders no
  next-slice line at all — which is exactly the pre-slice-set behaviour, and why
  every `epic`/`siblings` key is OMITTED rather than empty.
- **A frontmatter key outside `TaskFrontmatterSchema` is destructive, not
  merely ignored.** zod strips what it does not know, so `serializeTask` deletes
  it; `unknownFrontmatterKeys` is what the hub screens an in-place edit with, and
  `rewriteTask` refuses over it. Off-schema, every child would report as data an
  edit is about to lose, and a `retask` would lose it. There is no "just add the
  key" middle path — it is schema-or-nothing.

`siblings` is computed AFTER the move (so the approved slice is not its own
successor) and is best-effort: the approval is already committed, so a failed
listing costs the walk's next line and never the move.

## Every zod-mediated store strips what it does not declare — and a read-modify-write one rewrites history

Three stores now, which is why it is a rule rather than three docstrings:
`GitRefSchema.onCurrentBranch` (`persist.ts`), `epic`/`autoPlan`
(`TaskFrontmatterSchema`), and the metrics sidecar. Adding a field to a type a
zod store round-trips means adding it to the SCHEMA in the same change, pinned
by a round-trip test — TypeScript will not tell you, because structural typing
lets the extra key through `JSON.stringify` on the way OUT and only the read
side strips it.

The sidecar is the worst variant and the shape to watch for: `appendRunMetrics`
/`upsertRunMetrics` are read-modify-write, so an undeclared field is not merely
invisible to readers — the NEXT run's first flush re-parses every prior entry
and writes them back without it. `evidence` was declared on `StageSample` and
written by both hosts for exactly one run at a time. `metrics-file.test.ts` now
parses `StageSample`'s own source and fails on any field the schema is missing,
because a fixture-only test cannot fail for a field nobody thought to add to it.

## A leading token that names a real task is an ID, never a reason word

`rejectAny` takes `<id?> <reason…>` as one string, so the id is recovered by
RESOLVING the first token — and it must be resolved against every status folder
(`REJECT_ID_FOLDERS`), not only the ones `replan` acts on. Twice now the narrow
scan has produced the same silent wrong-target: a short-hash handle resolved by
exact filename only, then an id whose task had already moved to `queued/` (the
`replanQueued` retry arm, which is where a rejected task LIVES). Both fell
through to the id-less pick, which rejects the single `plan-review/` task — a
different task, its id folded into the reason, every message naming the task the
human did not ask about, and on OpenCode an immediate re-plan of it.

- **A token resolving in a NON-rejectable folder must refuse**, not fall through.
  `replanTask`'s wrong-folder message names the task it matched, so the failure is
  legible; falling through is what makes it invisible.
- **Fall through only when the token resolves NOWHERE** — that is the real
  "the whole argument is the reason" case.
- The cost is that a reason word prefixing a real id is claimed as an id. That
  trade was already made; it fails loudly, and the id-less form still exists.
- Both hosts route the typed `replan` verb through `rejectAny`, and OpenCode's
  `workflow_replan` too — so a folder unreachable here is unreachable from the
  verb entirely, however well core implements it.

## An id's quoting is stripped at the RESOLVER, not per host

`approve "f7k3-add-thing"` is a thing humans type, and a quote is not part of
any id — `SAFE_TASK_ID_RE` forbids one. The two hosts disagreed about who strips
it and both failed silently: the Claude/Qwen hook unquotes every id it forwards
(`gate-parse.mjs`), while the OpenCode driver takes ids straight off the raw
argument string. On OpenCode a quoted id therefore failed `isSafeTaskId`,
resolved to nothing, and every gate reported "no task found" for a file plainly
on disk — the same drift `verb.ts` documents one token over, where opencode
quote-strips `$1` and the plugin has to agree with it.

So `resolveTaskIdIn`/`resolveTaskIdAnywhere` strip it (`unquoteIdQuery`), which
is the one seam every id-taking verb on every host — and the hub — already goes
through. Two properties keep it sound, and a "simplification" of either
reopens the bug:

- **Only a MATCHED pair.** `replan "wrong approach"` splits into `"wrong` +
  `approach"`, and `rejectAny` claims any leading token that RESOLVES as an id;
  stripping half a quote would turn a reason word into a wrong-target id.
- **Before the safety screen, never after.** The screen is what stops a `../…`
  query reaching a path builder, so it has to judge the string that will
  actually be used.

The hosts' own unquoting stays as-is — it is also what feeds `remove`'s
`--force` detection — and is now a no-op for ids.

## An audit note is one line, and `appendNote` is what makes it one

An audit note is ONE `> …` line closed by a bracketed stamp. A reason with a
newline in it puts line 2 in the file with no `> ` prefix and the stamp detached,
so `AUDIT_NOTE_LINE_RE` stops matching: the orphaned lines then read as PROSE
(`auditTailIndex` loses the boundary, and they ride into every later `{{goal}}`)
and the last-note parsers — `extractReplanReason`, `extractRunBranch`,
`extractStopContext` — go blind. `replan` flattened; `retask` and `abandon`
interpolated raw, and the hub's `<textarea>` reaches them directly
(`z.string().trim()` does not touch interior newlines). The hazard is the SHAPE
OF THE NOTE, not the identity of the verb, so a new reason-writing verb belongs
in `oneLineReason` too.

Scoping the choke point to GATE REASONS is what kept the class alive: three
copies of the same raw `err.message` interpolation were written after that
section existed, each author reading "gate reasons" as not covering error
text. So the flatten now also happens in **`appendNote`**, at the write —
covering the move-failure correction arms (the notes that RETRACT a move the
trail already asserts, so the illegible one is the one that matters), a publish
failure's reason, and the hosts' model-authored `workflow_verdict` /
`workflow_blocked` text, whose "one-line reason" is contract prose a model is
free to ignore. `oneLineReason` stays: it also CLAMPS, and a gate reason has a
budget an audit note in general does not.

## Lifecycle state is parsed only from stamped audit lines

The same shape, read rather than written. A task body is a document a human and
a model both write in — and this backlog is made of tasks ABOUT the loop, whose
goals and plans quote the loop's own notes verbatim — so a bare
`re.test(task.body)` reads a QUOTATION as a fact about the run. `store.ts`
states this per-parser five times (`runDoneField`, `extractRunDiffstat`,
`pendingPlanRejection`, `extractStopContext`, `unaddressedRejectionCount`), and
it was never a rule, so the ship gate's publish-record parsers were written
without it: a completed task quoting "PR opened — https://…" anywhere pinned
`prAlreadyRecorded` true forever, killing the only path that can publish a
`local`/`push` ship afterwards — an explicit `approve <id> --pr` included —
behind "already completed. Nothing to do."

`auditNoteRecorded(body, pattern)` (`task/plan-section.ts`) is the choke point
for the "was this ever recorded" question; a parser that needs the LAST such
line still writes its own scan, anchored the same way.

## `queued/` is not the planless folder

`replanTask` re-queues a rejected task **with its plan intact**, so anything
reasoning "a queued task is planless" is wrong on the retry path — which is the
common path. `retaskTask` therefore MAKES it planless (`withoutPlanSections` +
`TASK_RESHAPED_MARKER`) rather than assuming it: a plan written against the goal
an interview is about to rewrite would otherwise ride into the next PLAN pass as
`priorPlan`, and its rejection would still be pending, handing that pass a
critique of a plan that no longer exists.

- **`withoutPlanSections` is not `stripPlanAndAuditTail`.** The persisted strip
  must KEEP every audit note; `appendPlan` appends at end of file, so plans and
  notes interleave and a first-heading-to-EOF cut deletes the trail.
- **The strip declines over off-schema frontmatter.** `rewriteTask` serializes
  through the schema and zod strips unknown keys, so the rewrite would delete
  them; a stale plan is recoverable, that is not. It warns and moves anyway — the
  MOVE is what the human asked for.
- **`TASK_RESHAPED_MARKER` must stay the note's prefix.** The strip removes the
  `PLAN_HEADING` anchor, so without that marker in `pendingPlanRejection`'s
  `addressed` set the rejection would go from retired back to pending purely as a
  side effect of the strip.

## An audit-trail counter needs an anchor on every path that resets it

The task file IS the ledger, so `pendingPlanRejection` and
`unaddressedRejectionCount` derive their state by counting notes after the last
`addressed` marker — crash-safe by construction, and wrong the moment a path
exists that ought to retire an entry but writes no marker either parser reads.
Twice now: `retask` (closed by `TASK_RESHAPED_MARKER`), then the park gate's own
3-strike return to `draft/`, which writes a note in ITS OWN wording and is
followed by a `retaskTask` that is a **no-op writing nothing** on a task already
in `draft/`. So the strikes survived the human triage, the next contract miss
counted 3 + 1, and the task was dumped straight back after ONE attempt under a
message tallying every cycle that ever ran — one higher each round, forever.

- **Anchor on the HUMAN's move, not the machine's.** `TASK_APPROVED_MARKER` is
  the fix because every route out of `draft/` crosses `approveTask`, so no way
  back can miss it — where anchoring on the return note would have covered only
  the path that happened to be reported. It also stays correct in the other
  direction: `replanTask` re-queues with no task gate, so a rejected plan's
  strikes rightly survive it.
- **The two parsers are allowed to disagree, deliberately.** The approval
  retires the strike TALLY and not the pending rejection REASON: the next PLAN
  pass still has to be told what it kept getting wrong, which is the whole job
  of `extractReplanReason`.
- **A marker is a contract with the note's writer.** Rewording a gate note is
  silent — nothing errors, the counter just stops retiring — so each anchor's
  writer is pinned by a test on the note it actually appends (`gate.test.ts` for
  the task-gate and reshape markers, `terminal.test.ts` for `Plan written`).
  Pin any new anchor the same way.
