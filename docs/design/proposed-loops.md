English | [繁體中文](proposed-loops.zh-TW.md)

# Proposed loop kinds — an enterprise workflow catalog

This is a **proposal catalog**, not a design record of shipped work (that's
[`improvements/`](./improvements/README.md)). It answers one question: beyond
the shipped `engineering` and `pr-sitter` kinds, what other loops would
automate the daily workflow of software engineers in enterprise environments?

Three entries below — `review-sitter`, `dep-sitter`, `main-sitter` — have
since shipped; each is marked **SHIPPED** with its deltas from the original
sketch. **For their current behavior and config, see
[`docs/sitters.md`](../sitters.md)** — the sketches below are kept as design
history, not as a second source of truth for what they do today.

Every entry is written against the real manifest contract
([`packages/core/loops/README.md`](../../packages/core/loops/README.md),
zod schema in `packages/core/src/manifest/schema.ts`) so any of them can be
promoted to an implementation plan without re-translation:

- **Work source** — whether the kind reuses `backlog` / `github-pr` or needs
  a new `WorkSource` under `packages/core/src/source/`. New sources dominate
  the implementation cost.
- **Stage graph** — stages with their `kind` (`work` completes on its own,
  `check` must record a `loop_verdict` or it FAILs), isolation, and the
  transition sketch (`fire` / `park` / `done` / `stop`, iteration budget).
- **Human gates** — where the loop parks and why. Every kind keeps the
  framework's stance: agents propose, humans dispose.
- **Authority & threat notes** — what authority the kind holds (see the
  legend below), tied back to [`threat-model.md`](./threat-model.md).
- **Config sketch** — its `loops.<kind>` section in `.agentic-loop.json`
  (every kind below is opt-in, like `pr-sitter`).
- **Cost** — S / M / L:
  - **S** — manifest + stage prompts + agents only; reuses an existing work
    source and grants no new authority.
  - **M** — needs one new work source or one new authority, with tests.
  - **L** — new source *and* new external authority; requires threat-model
    additions before it ships.

Authority levels used below, in increasing order of blast radius:

1. **backlog-write** — writes task files under the configured `tasksDir`
   (what engineering already holds).
2. **push** — pushes branches to the remote (never a protected branch).
3. **comment** — posts comments/reviews on PRs, issues, or work items.
4. **external-read** — reads an external system beyond the code platform
   (registry advisory DBs, Sentry, PagerDuty).
5. **external-write** — writes to an external system (Slack webhook, alert
   acknowledgement). The widest surface; always called out explicitly.

## Summary

| Kind | Category | Work source | Authority | Cost |
|------|----------|-------------|-----------|------|
| [debt-groomer](#debt-groomer) | Code health | `backlog` (reused) | backlog-write | S |
| [backlog-groomer](#backlog-groomer) | Collaboration | `backlog` (reused) | backlog-write | S |
| [review-sitter](#review-sitter) **(shipped)** | Collaboration | `github-pr` (+ `review-requested` trigger) | comment | S/M |
| [coverage-filler](#coverage-filler) | Code health | `backlog` (reused, own pool) | push | S/M |
| [issue-triager](#issue-triager) | Collaboration | new `github-issue` | backlog-write, comment | M |
| [dep-sitter](#dep-sitter) **(shipped)** | Code health | new `dependency-scan` | push, external-read | M |
| [release-gardener](#release-gardener) | CI/CD & release | new `merge-window` | push | M |
| [main-sitter](#main-sitter) **(shipped)** | CI/CD & release | new `ci-runs` | push, comment | M/L |
| [digest-reporter](#digest-reporter) | Ops & reporting | new `cron` | backlog-write (+ optional external-write) | S/M |
| [alert-triager](#alert-triager) | Ops & reporting | new `alert-feed` | backlog-write, external-read (+ optional push) | L |

---

## Code health & maintenance

### debt-groomer

Sweeps `TODO` / `FIXME` / deprecation markers out of the code and into the
backlog as reviewable task files. Never edits code.

- **Work source**: `backlog` reused inversely — the groomer doesn't claim
  existing tasks; a scheduled sweep (one synthetic task per run, claimed from
  a `groom-queue` status folder the kind seeds on poll) keeps the claim/lock
  discipline without a new source. If that bends the backlog source too far,
  a trivial `cron` source (shared with [digest-reporter](#digest-reporter))
  is the fallback.
- **Stage graph**:
  1. `scan` (**check**, isolation `none`, read-only `bashAllowlist`:
     `grep *`, `git log*`, `ls*`, `cat *`) — inventories markers, dedupes
     against open backlog tasks and its own ledger, records a verdict: PASS
     = new debt found, FAIL = nothing new.
  2. `draft` (**work**, isolation `none`) — writes one task file per debt
     cluster under `tasksDir`, with acceptance criteria naming the marker
     sites.
- **Transitions**: `scan` onPass → fire `draft`; onFail → done ("nothing
  new"). `draft` onDone → park `toStatus: "queued"` — straight into the
  existing engineering **task gate**; a human promotes or deletes.
- **Human gates**: everything. The groomer only ever produces parked task
  files; the engineering loop (with its own plan and ship gates) does the
  fixing.
- **Authority & threat notes**: backlog-write only — no push, no comment, no
  network. The cheapest and safest kind in this catalog; T3b (backlog
  corruption) is the only relevant threat, covered by the existing audited
  task-store writes.
- **Config sketch**:
  ```json
  { "loops": { "debt-groomer": { "enabled": true, "markers": ["TODO", "FIXME", "@deprecated"], "maxTasksPerRun": 5 } } }
  ```
- **Cost**: **S**.

### dep-sitter

> **Status: SHIPPED** — `packages/core/loops/dep-sitter/`. See
> [`docs/sitters.md`](../sitters.md) and
> [`docs/loops/dep-sitter.md`](../loops/dep-sitter.md) for its current
> behavior and config; the original sketch below is history only. v1 deltas
> from the sketch: majors are *skipped and logged* rather than parked (the
> `dependency-scan` source claims only patch/minor fixes whose target
> version the report pins — no `validateBeforeTransition` hook needed);
> `maxIterations` is 2; ecosystems are **npm** (native `npm audit`) and
> **Maven/Gradle** via OSV-Scanner. See threat model T12.

Original sketch: outdated/vulnerable dependencies, new `dependency-scan`
work source, `scan → upgrade → verify → publish` (push + external-read
authority), major bumps parked for a human. **Cost**: M.

### coverage-filler

Writes missing tests for modules a human has queued for coverage. Humans
seed the targets; the loop does the drudgework.

- **Work source**: `backlog` reused with its own claim pool — task files in a
  `coverage-queue` status folder (seeded by humans, by
  [digest-reporter](#digest-reporter)'s coverage section, or by a coverage
  diff in CI), claimed with a `coverage.isClaimable` predicate via the
  existing registry.
- **Stage graph**:
  1. `target` (**check**, isolation `none`) — confirms the module is still
     under-covered and enumerates the untested branches; FAIL = already
     covered (done).
  2. `write` (**work**, isolation `worktree`) — writes the tests, following
     the repo's test conventions.
  3. `verify` (**check**, isolation `worktree`) — new tests pass, coverage
     actually moved, and the tests fail when the code under test is broken
     (mutation spot-check — a test that can't fail is worthless).
  4. `publish` (**work**, isolation `worktree`) — pushes a branch and opens
     a draft PR.
- **Transitions**: `verify` onFail → fire `write`, `countIteration: true`
  (budget 3); onError → stop. `publish` onDone → done `toStatus:
  "in-review"`.
- **Human gates**: humans control the queue (nothing is claimed that a human
  didn't park into `coverage-queue`), and output is a draft PR.
- **Authority & threat notes**: push only, same posture as engineering's
  ship path. T1 (repo-content injection) applies to the code being read —
  covered by the existing verdict-tool-only discipline.
- **Config sketch**:
  ```json
  { "loops": { "coverage-filler": { "enabled": true, "coverageCommand": "npm run coverage -- --json" } } }
  ```
- **Cost**: **S/M** (no new source; the mutation spot-check in verify is the
  novel prompt work).

---

## Collaboration & triage

### issue-triager

Sits on incoming issues/work items: reproduces, dedupes, labels, and converts
accepted ones into backlog task files parked at the task gate — the bridge
from "someone filed a bug" to "the engineering loop can claim it."

- **Work source**: new `github-issue` — mirrors `github-pr`: a `query`
  (e.g. `is:open is:issue no:label`), triggers (`new-issue`,
  `new-comments`), a per-issue dedup ledger under
  `<tasksDir>/runs/issue-triager/`. ADO flavor polls work items via the
  existing REST/PAT plumbing.
- **Stage graph**:
  1. `triage` (**check**, isolation `none`, read-only + platform read
     allowlist) — attempts reproduction from the report, searches for
     duplicates, drafts a severity/area classification. PASS = actionable,
     FAIL = not actionable (needs-info / duplicate).
  2. `respond` (**work**, isolation `none`, platform comment allowlist) —
     for non-actionable issues: posts one comment (duplicate link or a
     specific needs-info ask) and applies labels.
  3. `draft` (**work**, isolation `none`) — for actionable issues: writes a
     backlog task file with reproduction steps and acceptance criteria,
     linking the issue.
- **Transitions**: `triage` onPass → fire `draft`; onFail → fire `respond`.
  `draft` onDone → park `toStatus: "queued"` (the task gate). `respond`
  onDone → done.
- **Human gates**: accepted issues become *parked task files*, not work in
  flight; a human promotes them. The triager never closes an issue — it
  labels and comments only.
- **Authority & threat notes**: backlog-write + comment. Issue bodies are
  the canonical untrusted input — the T7 injection discipline (external text
  is data, verdicts only via `loop_verdict`) applies verbatim, and the
  triage stage's allowlist keeps it read-only. Comment authority is bounded
  to the claimed issue, mirroring T8's "authority no wider than the job."
- **Config sketch**:
  ```json
  { "loops": { "issue-triager": { "enabled": true, "query": "is:open is:issue no:label", "labels": { "needsInfo": "needs-info", "duplicate": "duplicate" } } } }
  ```
- **Cost**: **M** (one new source; comment authority already modeled).

### review-sitter

> **Status: SHIPPED** — `packages/core/loops/review-sitter/`. See
> [`docs/sitters.md`](../sitters.md) and
> [`docs/loops/review-sitter.md`](../loops/review-sitter.md) for its current
> behavior and config; the original sketch below is history only. v1 deltas
> from the sketch: the middle work stage is named `assess` (not `review` —
> the OpenCode driver special-cases a stage named `review` for lens fan-out);
> there is no `maxDiffLines` knob — the fetch stage FAILs (→ done) on
> unreviewably-large diffs instead; a re-request without a new push does not
> re-fire (dedup rides the head SHA); fork and draft PRs stay skipped
> (threat model T10/T11).

Original sketch: the mirror of pr-sitter, `github-pr` reused with a
`review-requested` query/trigger, `fetch → review → publish` (comment-only
authority, no iteration budget). **Cost**: S/M.

### backlog-groomer

Walks stale `queued` backlog tasks and keeps them shovel-ready: adds missing
acceptance criteria, splits tasks too big to verify, flags ones the codebase
has drifted past.

- **Work source**: `backlog` reused — a pool over `queued` with a
  `groomer.isStale` claim predicate (no acceptance bullets, or untouched for
  N days; both readable from the task file and its git history).
- **Stage graph**:
  1. `assess` (**check**, isolation `none`, read-only allowlist) — decides
     whether the task needs grooming and what kind (criteria / split /
     obsolete). FAIL = fine as-is.
  2. `groom` (**work**, isolation `none`) — edits the task file in place
     (audited store write), or writes the split-out children, or appends an
     "obsolete?" note with evidence.
- **Transitions**: `assess` onPass → fire `groom`; onFail → done. `groom`
  onDone → park `toStatus: "queued"` — groomed tasks land back at the task
  gate marked as groomed (so the same task isn't re-claimed next poll; the
  predicate checks the groom marker).
- **Human gates**: the groomer never deletes or promotes a task — obsolete
  ones are *flagged*, splits are *proposed as new queued tasks*, and the
  human decides at the existing task gate.
- **Authority & threat notes**: backlog-write only, same T3b surface as
  debt-groomer; the audited task-store writes and claim locks already cover
  it.
- **Config sketch**:
  ```json
  { "loops": { "backlog-groomer": { "enabled": true, "staleAfterDays": 14 } } }
  ```
- **Cost**: **S**.

---

## CI/CD & release

### main-sitter

> **Status: SHIPPED** — `packages/core/loops/main-sitter/`. See
> [`docs/sitters.md`](../sitters.md) and
> [`docs/loops/main-sitter.md`](../loops/main-sitter.md) for its current
> behavior and config; the original sketch below is history only. v1 deltas
> from the sketch: the `ci-runs` source judges only the branch's *newest*
> head (older red heads are moot once a newer push exists; a green re-run
> retires the item naturally) and never claims a head with runs still in
> flight; the remedy branch is `main-sitter/<sha>` and the push allowlist is
> scoped to it, so the watched branch is structurally unpushable. Supports
> both GitHub (`gh run list`) and Azure DevOps (the Pipelines Build REST
> API, `ado-ci-runs.ts`, sharing its ledger/WorkItem mechanics with the
> GitHub source). See threat model T13.

Original sketch: default-branch CI, new `ci-runs` work source,
`diagnose → remedy → verify → publish` (push + comment authority, bisects
to the culprit, proposes a fix or revert as a draft PR — never a direct
push to main). **Cost**: M/L.

### release-gardener

Tends the release: when unreleased merges accumulate past a threshold (or a
cadence arrives), it drafts the changelog, release notes, and version bump
on a branch, then parks at a release gate. Tagging and publishing stay
human.

- **Work source**: new `merge-window` — computes "merges since the last
  tag" (`git log <lastTag>..origin/main`, PR metadata via the platform);
  emits one work item when the threshold/cadence trips, deduped by the
  candidate base commit in its ledger.
- **Stage graph**:
  1. `collect` (**check**, isolation `none`, read-only + platform read) —
     gathers merged PRs since the last tag, classifies (feature / fix /
     breaking) from labels and conventional-commit prefixes; FAIL = window
     not worth a release.
  2. `draft` (**work**, isolation `worktree`) — writes the changelog
     section, release notes, and version bump per the repo's versioning
     convention.
  3. `verify` (**check**, isolation `worktree`) — build passes with the
     bumped version; changelog references only real PRs (spot-checked
     against the collect artifact); no source files touched beyond the
     allowlisted release files.
  4. `publish` (**work**; push allowlist) — pushes the release branch and
     opens a draft release PR.
- **Transitions**: `collect` onPass → fire `draft`; onFail → done. `verify`
  onFail → fire `draft`, `countIteration: true`, budget 2. `publish`
  onDone → park `toStatus: "release-review"` — the **release gate**.
- **Human gates**: the release gate is the point — a human reviews notes,
  merges, tags, and publishes. The gardener holds no tag or registry
  authority whatsoever.
- **Authority & threat notes**: push only. PR titles/labels feeding the
  notes are lightly untrusted (T7-lite): the verify stage's
  cross-check-against-collect artifact is the control against fabricated
  changelog entries.
- **Config sketch**:
  ```json
  { "loops": { "release-gardener": { "enabled": true, "minMerges": 8, "cadence": "weekly", "versioning": "semver" } } }
  ```
- **Cost**: **M**.

---

## Ops & reporting

### digest-reporter

The standup you don't have to write: each morning it summarizes yesterday's
merges, open-PR states, CI health, and loop-run metrics into a markdown
digest — committed to the repo, optionally posted to chat.

- **Work source**: new `cron` — the simplest possible source: fires one work
  item per configured schedule slot, deduped by date in its ledger. (Once it
  exists, [debt-groomer](#debt-groomer) and
  [release-gardener](#release-gardener)'s cadence mode ride on it too.)
- **Stage graph**:
  1. `gather` (**check**, isolation `none`, read-only + platform read
     allowlist) — collects merges, PR states, CI status, and per-run stage
     timings/verdicts from the existing run metrics
     (`packages/core/src/loop/metrics.ts`); FAIL = nothing happened (skip
     quiet days).
  2. `render` (**work**, isolation `none`) — writes
     `<tasksDir>/runs/digest/YYYY-MM-DD.md` via the audited store (secret
     redaction applies on the way in, per the existing redaction path).
  3. `post` (**work**, optional — only wired when a webhook is configured;
     allowlist is exactly one `curl` glob to the configured webhook host) —
     posts the digest summary to Slack/Teams.
- **Transitions**: `gather` onPass → fire `render`; onFail → done ("quiet
  day"). `render` onDone → fire `post` if configured, else done. `post`
  onDone → done.
- **Human gates**: none needed for the committed digest (read-only
  reporting); the external post is gated by configuration, not by a human
  per-run.
- **Authority & threat notes**: backlog-write for the digest file;
  **external-write** only if the webhook leg is enabled — the first
  external-write in the framework, so it gets the strictest shape: one
  destination, allowlisted host, digest content passes the existing secret
  redaction (T6) before leaving the machine. Threat model gains a "webhook
  egress" note.
- **Config sketch**:
  ```json
  { "loops": { "digest-reporter": { "enabled": true, "schedule": "weekdays 08:00", "webhook": null } } }
  ```
- **Cost**: **S/M** (trivial source; the webhook leg is the only novel
  authority and is optional).

### alert-triager

Sits on production alerts (Sentry, PagerDuty, Datadog): correlates each new
alert with recent merges and stack traces, and parks a written diagnosis for
the on-call human — optionally continuing into a draft fix PR.

- **Work source**: new `alert-feed` — polls the alerting API for new/open
  alerts matching a filter, deduped by alert ID in its ledger; credentials
  via env (PAT-style, mirroring `AZURE_DEVOPS_EXT_PAT`).
- **Stage graph**:
  1. `triage` (**check**, isolation `none`; external-read allowlist for the
     alert API + read-only git) — pulls the alert payload and stack trace,
     correlates against recent merges (`git log` since last deploy),
     classifies: code-linked, infra, or noise. FAIL = noise/known.
  2. `diagnose` (**work**, isolation `worktree`) — reads the implicated
     code, reproduces if a test can express it, writes a diagnosis document:
     suspected commit, mechanism, blast radius, suggested remedy.
  3. `propose-fix` (**work**, isolation `worktree`; **optional**, off by
     default) — writes the fix + regression test.
  4. `verify` (**check**, isolation `worktree`) — regression test fails
     before / passes after.
  5. `publish` (**work**; push allowlist) — draft PR linking the alert and
     the diagnosis.
- **Transitions**: `triage` onPass → fire `diagnose`; onFail → done.
  `diagnose` onDone → park `toStatus: "diagnosis-review"` when `autoFix` is
  off (the default) — the on-call human reads the diagnosis and decides;
  when `autoFix` is on → fire `propose-fix`. `verify` onFail → fire
  `propose-fix`, `countIteration: true`, budget 2. `publish` onDone → done.
- **Human gates**: the default terminal state *is* the gate — a parked
  diagnosis. The fix path is an explicit opt-in, and even then lands as a
  draft PR. The triager never acknowledges, resolves, or silences alerts.
- **Authority & threat notes**: the largest surface in this catalog —
  external-read of an alert API plus (opt-in) push. Alert payloads are
  attacker-influenceable in the worst case (error messages contain user
  input): the T7 injection discipline applies at full strength, the triage
  stage is allowlist-pinned read-only, and credentials never enter durable
  artifacts (T6 redaction). Ships only after its own threat-model section
  (new trust boundary: the alerting provider).
- **Config sketch**:
  ```json
  { "loops": { "alert-triager": { "enabled": true, "provider": "sentry", "filter": "is:unresolved level:error", "autoFix": false } } }
  ```
- **Cost**: **L**.

---

## Suggested build order

Cheapest-first, each wave reusing what the previous one built:

1. **No new source, no new authority** — [debt-groomer](#debt-groomer),
   [backlog-groomer](#backlog-groomer),
   [review-sitter](#review-sitter) *(shipped)*: manifests, stage prompts, and
   agents only. These prove the catalog format against the engine as it
   stands.
2. **One new source each** — [issue-triager](#issue-triager)
   (`github-issue`), [dep-sitter](#dep-sitter) (`dependency-scan`,
   *shipped*), [main-sitter](#main-sitter) (`ci-runs`, *shipped*),
   [release-gardener](#release-gardener) (`merge-window`), plus
   [coverage-filler](#coverage-filler) riding the backlog. Each source
   follows the `WorkSource` contract and the pr-sitter ledger pattern.
3. **External integrations last** — [digest-reporter](#digest-reporter)'s
   webhook leg and [alert-triager](#alert-triager), each preceded by its
   threat-model addition.

Promoting any entry to real work means walking the existing
[checklist for a new kind](../../packages/core/loops/README.md#checklist-for-a-new-kind)
— manifest + stages, agents for both plugins via `gen:prompts`, command
wrappers, source + tests, registry hooks, and the config/threat-model docs.
That checklist is authoritative; this catalog only supplies the *what*.
