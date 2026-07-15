# Proposed hub features — closing the read/write gap

This is a **proposal + implementation plan**, not a design record of shipped
work (that's [`improvements/`](./improvements/README.md), whose seven plans are
all **core-side** — the hub has had no design home until this file).

It answers one question: beyond the shipped read-only monitor and loop creator,
what should [`packages/hub/`](../../packages/hub/README.md) do next?

The answer is driven by a single measurable observation: **core exposes a
complete write API that the hub never calls.** Every feature below closes one of
those gaps, and — the load-bearing finding — **none of them needs new code in
core.**

For what the hub does *today*, see
[`packages/hub/README.md`](../../packages/hub/README.md); for its place in the
system, [`architecture.md`](../architecture.md); for config keys,
[`configuration.md`](../configuration.md). This doc does not restate them.

Every entry is written against the real contracts (paths and line numbers
verified against source at time of writing) so any of them can be executed
without re-translation:

- **Gap** — the core export that exists, is tested, and has zero hub callers.
- **Surface** — the routes, wire types, and components, following the patterns
  already established in `packages/hub/src/server/routes/kinds.ts`.
- **Authority** — what the feature lets a browser click do, tied back to
  [`threat-model.md`](./threat-model.md). Same ladder as
  [`proposed-loops.md`](./proposed-loops.md), plus one new rung.
- **Cost** — S / M / L:
  - **S** — routes + components only; composes existing core exports, grants no
    new authority.
  - **M** — new authority, with tests.
  - **L** — new authority *and* a novel failure mode that needs its own rails.

Authority levels, in increasing order of blast radius:

1. **read** — no writes (what the hub holds today).
2. **backlog-write** — writes task files under the configured `tasksDir`, and
   commits them (what the engineering loop already holds).
3. **config-write** — writes `.agentic-loop.json`. **New rung, hub-specific**:
   config is the file that grants every *other* authority, so writing it is a
   step up from backlog-write even though it touches one small file.
4. **push / comment** — pushes branches, opens PRs. Visible outside the machine.

## Summary

| # | Feature | Gap it closes | Authority | Cost |
|---|---------|---------------|-----------|------|
| [1](#1--gate-actions) | Gate actions | `loop/gate.ts` — **zero hub callers** | backlog-write, push | M |
| [2](#2--backlog-doctor) | Backlog doctor | write half of `task/store.ts` | backlog-write | M |
| [3](#3--creator-prompt-preview) | Creator prompt preview | `manifest/template.ts` `renderPrompt` | read | S |
| [4](#4--config-editor) | Config editor | **nothing anywhere writes `.agentic-loop.json`** | config-write | L |

Recommended order — **PR 0 (foundation) → 3 → 1 → 2 → 4** — is justified under
[Sequencing](#sequencing). The config editor is the headline ask and ships
**last**, deliberately.

---

## The gap

The hub is a beta admin app that **observes** the loop: backlog board, live
activity, run history, token usage, loop creator. All read-only, by design —
[`architecture.md`](../architecture.md) says it "**observes** … and never drives
the loop".

That stance has gone stale in four specific places:

| Core capability | Status | Hub today |
|---|---|---|
| `loop/gate.ts` — `approveTask:101`, `approvePlan:150`, `replanTask:200`, `shipTask:241` | shipped, tested | **zero callers.** Hub detects gates (SSE `gate` events, `gateStatuses` column highlighting) and can act on none of them. `packages/hub/README.md:111` defers this explicitly. |
| `task/store.ts` write half — `rescueStray:549`, `releaseOrphanedClaims:456` | shipped, tested | unused. `Board.tsx:65` renders a dead-end chip reading *"backlog anomalies — run doctor"* — it tells you to go type a CLI verb. |
| `.agentic-loop.json` | — | **nothing writes it.** `routes/kinds.ts:108` ends the creator flow by telling you to hand-edit the file. |
| `manifest/template.ts` `renderPrompt:61` | shipped, tested | unused. The creator writes prompt stubs blind. |

**The stance is already broken in practice**: the creator writes
`loops/<kind>/` via `POST /api/kinds` (`routes/kinds.ts:113`). So the honest
move is to formalize the boundary, not to pretend it holds.

### The new boundary

> The hub performs the **human gate moves**, **backlog repairs**, and **config
> edits** — through the *same shared core entry points both hosts already use*.
> It does not drive **stages**.

The hub becomes a **fourth caller of the gate, not a fourth driver**. That
distinction is the whole safety argument and it should be stated in exactly
those words wherever it's documented.

### Why core needs no new code

This is the strongest signal the design is right. `GateCtx` (`gate.ts:22-35`) is
a host-injection seam whose docstring **already anticipates a third host**
answering `isDriving` "from the on-disk stage marker". The hub is that host.

| Need | Core export | Verdict |
|---|---|---|
| Gate ops | `approveTask:101`, `approvePlan:150`, `replanTask:200`, `shipTask:241` | Compose. `HubDeps` already supplies every `GateCtx` field; only a `sh`→`$` rename. |
| Doctor | `auditBacklog`, `rescueStray:549`, `releaseOrphanedClaims:456`, `isOrphanedPlanClaim:406`, `listClaimIds`, `appendNote:578`, `commitPaths` | Compose. |
| Preview | `renderPrompt:61`, `promptContext:32`, `verdictContractBlock` (`verdict.ts:79`) | Compose — **not** `composePrompt:68` (see [3](#3--creator-prompt-preview)). |
| Config | `mergeConfigLayers:248`, `readUserLayer:293`, `resolveUserConfigPath:230`, `ConfigSchema:150`, `BaseConfigSchema.shape` | Compose. |
| Provenance | — | **Hub.** Core would need a second copy of the merge rule. See [Crux B](#crux-b--the-layer-footgun). |
| Per-kind knob validation | — | **Hub, advisory.** Tightening core is a breaking change. See [Crux C](#crux-c--loops-is-looseobject). |

Two ~1-line core touches, both comments: a pointer at `orchestrate.ts:107` to
hub's knob registry, and one at `config.ts:94` noting the loose contract is
intentional and linted downstream.

**If a PR here starts wanting to change core, that is the alarm that the feature
drifted.**

---

## 1 — Gate actions

**Authority: backlog-write, push · Cost: M**

Approve / replan / ship buttons on gate-column task cards.

**Server** — new `server/routes/gate.ts`, repo-scoped, `mutating: true`:

```
POST /api/gate/:action    body: { id, expectStatus, reason?, kind? }
  action ∈ approve-task | approve-plan | replan | ship
```

Three decisions carry this route:

- **Map 1:1 onto the explicit ops**, not the `*Any` shortcuts. `approveAny:320`
  exists to resolve ambiguity *from a CLI where the human typed no id*. A hub
  button lives on a specific card in a specific column — the ambiguity doesn't
  exist. Using `approveAny` would let a race perform a *different gate than the
  button said*.
- **`expectStatus` is non-negotiable.** The board is SSE-driven and can lag.
  Verify the task is still in the status the client saw (one `findByIdIn`);
  mismatch → **409** with the current status. Without it, a click on a stale
  board can ship a task the loop already moved.
- **The 200 rule.** Return **200 for every well-formed request**, carrying
  `GateResult` verbatim. `ok: false` is a *domain refusal* ("it's in queued, not
  draft"), not a transport error — and `web/api.ts`'s `parse` throws on
  `!res.ok` (:5-8), which would discard `variant`, the info-vs-warning
  distinction core deliberately models (`gate.ts:38-46`). Reserve 400 for
  malformed body / bad id, 409 for `expectStatus` mismatch.

Screen `id` through `isSafeId` (`http.ts:85`) before it reaches the filesystem —
the rule `backlog.ts:84` already applies. Short-hash prefixes (`f7k3`) pass.

**Wire types** — `export type { GateResult, GateVariant } from
"@agentic-loop/core/loop/gate"`. The type-only re-export pattern at
`shared/api.ts:7-8`; zero hand-maintained duplication.

**Web** — `web/monitor/GateActions.tsx`, mounted in `Board.tsx`'s `TaskCardView`
(:16), which already receives `gated: boolean`. Every button wraps in
`<Confirm>`.

**Ship is the largest posture change in this document** and its copy must say
so. `shipTask:259` calls `shipPr` — a browser click opens a real pull request on
a real remote. `variant="danger"`, and the confirm detail reads: *"commits to
git AND opens a pull request. This is visible outside your machine."*
Deliberately **not** mitigated by a dry-run — a fake ship that doesn't ship is a
worse lie than a confirm.

No new SSE type: gate ops move files under `tasksDir`, and `watch.ts` already
emits `backlog` / `gate`. Render `result.message` optimistically; let SSE
reconcile.

---

## 2 — Backlog doctor

**Authority: backlog-write · Cost: M**

Mirror `loop_doctor` semantics **exactly** — the MCP server and the OpenCode
verb already agree, and a third divergent semantic would be a bug factory.

**Server** — new `server/routes/doctor.ts`:

- `GET /api/doctor` (scoped, read-only) — `auditBacklog` + `formatAnomalies` +
  `listClaimIds` → `{ findings, anomalies, heldClaims }`.
- `POST /api/doctor/fix` (scoped, `mutating: true`) — `rescueStray:549` per
  stray + an audit note; rmdir unknown dirs; `releaseOrphanedClaims:456` with
  `isOrphaned: isOrphanedPlanClaim` (`store.ts:406`) **for `queued` only** —
  easy to miss, and getting it wrong releases live plan claims. One
  `commitPaths` at the end.

**Duplicates are never auto-fixed.** Both hosts refuse; the hub refuses. Surface
them with the same guidance ("keep one copy, move the rest to abandoned"). The
hub is the *worst* place to guess which copy is canonical — do not add a
hub-only "resolve duplicate" button.

**Claim release is the delicate half.** Releasing a claim a loop actively holds
lets a second claimer grab the same task. Note the inversion from the gate:
there, a claim means "refuse"; here, the claim *is* the thing being released, so
`isDriving` cannot be the test — every candidate is claimed by definition. Use
core's own orphan predicates instead (`isOrphanedClaim:394`, and
`isOrphanedPlanClaim:406` for `queued/`), which is exactly what
`releaseOrphanedClaims:456` takes them for. Strays and empty dirs are unrelated
and always safe to fix.

**Web** — `web/monitor/DoctorPanel.tsx`. The hook point already exists: turn
`Board.tsx:65`'s dead-end chip into the button that opens the panel.
`BacklogResponse.anomalies` already drives its visibility.

---

## 3 — Creator prompt preview

**Authority: read · Cost: S**

Render a stage prompt with sample context, inside the creator.

`POST /api/kinds/preview` — a **non-`mutating`** POST, following the
`validateKind` precedent (`main.ts:141`). Nothing is written; the
`X-Hub-Client` header guards side effects, not reads.

**Do not call `composePrompt`** (`engine.ts:68`). It throws on exactly the kinds
the creator authors, for two reasons: it needs a `LoadedManifest` read from disk
(the manifest being previewed isn't saved yet), and it resolves
`hooks.compose[stage]` through the registry — which for a hub-authored kind
names an unregistered hook. Compose the underlying exports directly:

```
renderPrompt(prompts[stage], promptContext(sampleState))
  + if stage.kind === "check" → append verdictContractBlock(stage)   // verdict.ts:79
  + if manifest.hooks.compose[stage] → note: "stage has compose hook <ref>;
                                              preview shows the un-hooked render"
```

Faithful to `composePrompt`'s output, and cannot throw.

**The sample-state toggles are the whole feature.** The value isn't "see the
text" — it's *seeing which conditional blocks fire*. Give the UI three switches
(with-task / with-git / with-worktree) so an author immediately watches
`{{#task.id}}` and `{{#worktree}}` light up or vanish. Without them this is a
glorified `cat`.

**Server-side, not client-side** — a real tradeoff, named: `renderPrompt` is
pure and *could* run in the browser. But `shared/api.ts:11-13` states the
boundary — the SPA imports core **type-only**, never runtime. Pulling
`template.ts` + `engine.ts` into the bundle to save a 2 ms round-trip breaks
that boundary for one feature. Take the POST.

---

## 4 — Config editor

**Authority: config-write · Cost: L**

The headline ask, and the one with real footguns. New `server/configfile.ts`
(raw layer IO), `configlayers.ts` (provenance), `knobs.ts` (advisory lint),
`routes/config.ts`.

Cost is **L**, not M, because two of the three cruxes below are novel failure
modes — silent data destruction and secret exfiltration — that need their own
rails, not just tests.

### Crux A — the strip footgun

**Raw is the model; zod is only a linter.**

`BaseConfigSchema` (`config.ts:61`) is a plain `z.object` → **zod v4 strips
unknown keys**. So `ConfigSchema.parse(raw)` followed by writing the result
silently deletes:

- **`watchIntervalMinutes`** — host-only, added by the OpenCode plugin via
  `safeExtend` (`plugins/opencode/src/config.ts:21`), not in core; and
- **the entire `hub` section** (`packages/hub/src/server/config.ts:12`) — *which
  is how the hub found this repo in the first place*.

Writing a parsed config makes the hub delete its own configuration. The
algorithm exists to prevent that:

```
READ(layer):
  raw    = JSON.parse(readFileSync(<layerPath>))   // parse error → 200 {parseError}, NOT 500 —
                                                   // the editor must render it
  merged = mergeConfigLayers(userRaw ?? {}, repoRaw ?? {})   // core's exported merge, verbatim
  issues = ConfigSchema.safeParse(merged).issues             // .data DISCARDED — validator only
  → { layer, raw, effective, issues, provenance, passthrough, redactedPaths }

WRITE(layer, patch):
  raw  = re-read from disk NOW (never trust a client echo)
  next = applyPatch(raw, patch)                    // key-path set/delete on the RAW object
  un-redact: patch value === "__REDACTED__" → keep raw's existing value
  issues = ConfigSchema.safeParse(merged-with-next).issues → any? 400.
                                                   // never write an invalid config
  warnings = lintLoopKnobs(next.loops, boards)     // advisory, does NOT block
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n")
  repo.reload() → 200 { written, warnings }
```

`next` descends from `raw`, so unknown keys survive **because they were never
round-tripped through zod**.

**Make the invisible visible.** Don't just silently preserve unknowns — return
`passthrough`: keys present in raw but absent from `BaseConfigSchema.shape`,
rendered as a read-only section. `watchIntervalMinutes` and `hub` then appear
*labeled, preserved, uneditable* — and a top-level typo (`maxIteration`) shows
up there instead of vanishing. Same mechanism, honest UX, catches a real class
of bug for free.

The `hub` section stays **read-only in v1**: it's read once at startup
(`main.ts:48`), so editing it from the hub would silently do nothing — worse
than not offering it. A repo-level `hub` key is already deliberately ignored as
circular (`hub/src/server/config.ts:5-10`); the editor refuses it rather than
writing a key nothing reads.

### Crux B — the layer footgun

**Edit one named layer; compute provenance in hub, not core.**

`mergeConfigLayers:248` merges the user layer (`~/.agentic-loop.json`) **under**
the repo layer, *before* the parse. An editor that showed the *effective* merged
config and saved it back to the repo file would **flatten the user layer into
the repo file** — writing `ado.pat` out of `~/.agentic-loop.json` and into a
file that `config.ts:121-126` explicitly warns must stay gitignored.

**That is secret exfiltration, and it is the single worst thing this feature
could do.** Four rails:

1. **The route is layer-explicit.** `GET/POST /api/config?layer=repo|user` (plus
   `?repo=<id>`). No "effective" editing mode, ever. `effective` is
   display-only, visibly read-only, beside a per-field provenance badge.
2. **Provenance lives in hub, not core.** `readUserLayer:293` is exported
   precisely for this (its docstring cites the hub); the repo layer is a file
   read. `provenanceOf(userRaw, repoRaw, path) → "repo" | "user" | "default"` is
   ~20 lines. Putting it in core would mean **a second implementation of the
   merge rule to keep in lockstep with `mergeConfigLayers`** — the exact
   two-copies-drift failure this codebase already fights (`audit.ts:2-5`,
   `kinds.ts:98-108`). Core's contract stays single: one merge function,
   exported.
   **But mirroring is exactly where this goes wrong**, so pin it with an oracle
   rather than trust: a property test asserting, for every leaf path over
   generated layer pairs, that the value in `mergeConfigLayers(u, r)` equals the
   value in the layer provenance names. Drift becomes a red test, not a wrong
   badge. The mirror must use the **same recursion rule** — only plain objects
   recurse; **arrays, scalars and `null` replace wholesale** (`config.ts:248-257`).
   A naive per-element walk of `reviewLenses` would report provenance that
   `mergeConfigLayers` does not implement.
3. **`ado.pat` never reaches the browser.** Redact at a *known path*, not by
   regex: replace with sentinel `"__REDACTED__"`, list the path in
   `redactedPaths`. A write echoing the sentinel means "unchanged" → keep raw's
   existing value. This is why the write re-reads from disk instead of trusting
   a client echo.
4. **Gitignore guard.** Before a write that *sets* `ado.pat` in the **repo**
   layer, run `git check-ignore -q .agentic-loop.json`. Not ignored → **400**
   carrying the warning from `config.ts:121-126`. Two lines that turn a doc
   comment nobody reads into an enforced rail, at exactly the moment it matters.

### Crux C — `loops` is `looseObject`

**Lint in hub as warnings; do not touch core's schema.**

`orchestrate.ts:107-138` reads per-kind knobs **positionally by string key with
bare `typeof` checks**:

| `workSource.type` | knob | check | site |
|---|---|---|---|
| `github-pr` | `query` | string | `orchestrate.ts:112` |
| `dependency-scan` | `severityFloor` | string | `:124` |
| `dependency-scan` | `includeOutdated` | boolean | `:125` |
| `dependency-scan` | `ecosystem` | string | `:126` |
| `ci-runs` | `branch` | string | `:132` |

A typo (`severityfloor`) or a wrong type (`severityFloor: 7`) is **silently
ignored** — the loop runs on a default and nobody is told. Catching this is the
config editor's best selling point.

> **Note:** this table is currently discoverable only by reading
> `orchestrate.ts`. [`configuration.md:126`](../configuration.md) claims these
> knobs are "validated by the kind itself"; they are not. Fixing that doc is
> worthwhile independent of this feature.

**Tightening core's `loops` schema is the wrong move**, and this is the one
place to push back hardest. `looseObject` is *deliberate* (`config.ts:86-90`:
kind-specific knobs "ride along and are validated by the kind itself") and kinds
are user-authorable — the entire creator feature exists to author them. Making
it strict is a **breaking change**: every existing config carrying a knob core
doesn't know fails `loadConfig`, breaking both hosts and every user's repo at
once. A per-kind schema keyed off `manifest.workSource.type` would have to live
in core, load per kind, and stay in sync with `orchestrate.ts` anyway — same
drift, higher blast radius.

Instead: `server/knobs.ts`, an advisory registry keyed by `workSource.type`
(available from `deps.boards[].sourceType`). `lintLoopKnobs(rawLoops, boards) →
ConfigWarning[]`, four classes, all **non-blocking** — they annotate the write,
never fail it:

- **unknown key** — `severityfloor` → *"unknown knob; did you mean
  `severityFloor`? It will be silently ignored."* Case-insensitive +
  edit-distance-1 catches essentially every real typo.
- **wrong type** — `severityFloor: 7` → *"read only when a string
  (`orchestrate.ts:124`); ignored."*
- **wrong source** — `query` on a backlog kind → *"only applies to `github-pr`
  kinds; ignored."*
- **unknown kind** — a `loops.<kind>` with no `loops/<kind>/` manifest.

**Named tradeoff:** this registry duplicates knowledge that lives in
`orchestrate.ts` and can drift. Accepted, with a ~15-line mitigation: a
**drift-alarm test** that reads `orchestrate.ts` source, regexes out every knob
access, and asserts the set equals the registry's keys. If drift ever bites, the
escape hatch is to promote the registry into core *next to* orchestrate and have
orchestrate read from it — a strictly better end-state, but not worth blocking
this on.

### Closing the kinds.ts loop

`routes/kinds.ts:98-108` reads `.agentic-loop.json` with a raw `fs.readFileSync`
+ `JSON.parse`, bypassing core's `loadConfig`, purely to check
`loops.<kind>.enabled` — then emits a hand-edit-the-file checklist item at :108.
Replace the raw read with `readConfigLayer(deps, "repo")`, and turn :108 into
`{ done: enabled, label: "enable in the Config tab", href: "#config" }`.

That is the loop this feature exists to close, and it's why PR 0 scopes the
kinds routes.

### The reload story

Config is read at **startup only** (`main.ts:86`); nothing watches
`.agentic-loop.json`. **Both halves are required** — the write route alone
leaves the server stale after any `$EDITOR` edit, which is the common case:

1. **Write route → `repo.reload()`.** In-process, no restart.
2. **Watcher → reload.** Add `configKey` to `WatchSnapshot` (`watch.ts:13-22`)
   and `scanSnapshot` (:37); `diffSnapshots` emits a new `{ type: "config" }`
   event; `main.ts:157`'s broadcast callback calls `repo.reload()` **before**
   fan-out; `web/events.tsx` gains a `config` version counter.

Two consequences to handle, not assume away:

- **Reload can throw** (bad JSON, `kindBoards` on a broken manifest) → catch,
  **keep the old deps**, log, and *still broadcast* so the config route renders
  the parse error properly. A broken hand-edit must never blank the board or
  kill the server.
- **`tasksDir` or the status union can change**, and the watcher is constructed
  from both (`main.ts:149-158`) → on reload, if either changed, stop and restart
  that repo's watcher. Otherwise the hub silently watches the old folder
  forever.

---

## Sequencing

**PR 0 (foundation) → 3 (preview) → 1 (gate) → 2 (doctor) → 4 (config).**

The four features are not equally coupled. Gate, doctor, and config all need the
same three things that don't exist today: a live `Config` on `HubDeps`, an
`isDriving` oracle, and repo-scoped kinds routes. Building those inside whichever
feature shipped first would bury them; building them once, first, makes every
later PR small.

- **Config ships last** despite being the headline ask — it's the only one
  needing a reload story, and reload is far easier once `repo.deps` is a mutable
  box PR 0 introduced and PRs 1–2 have exercised.
- **Preview ships second** — trivial and read-only, it shakes out PR 0's
  scoped-kinds change with no write risk.
- **Gate before doctor** — doctor reuses `isDriving` under a *stricter*
  correctness bar (releasing a live claim is worse than refusing a replan).

### PR 0 — write-path foundation — **SHIPPED**

Ships no user-visible feature. Everything after it is small.

- **`server/deps.ts`** — `readonly config: Config` on `HubDeps`.
- **`server/repo.ts`** (new) — the repo registry, with `reload()`. Extracted out
  of `main.ts` rather than added to it: `main.ts` is a side-effecting entry
  script (parses argv, binds a socket, exits on bad input), so nothing in it can
  be imported by a test — and `reload()`'s keep-the-last-good-config rail is
  worth proving. `scoped()` already re-reads `repo.deps` per request, so
  reassigning the field needs no handler plumbing. A reload that moves `tasksDir`
  or the status union also restarts the watcher, which is built from both.
- **Scope the kinds routes** — `getKinds` / `getKind` / `validateKind` /
  `saveKind` passed `defaultRepo.deps`, so `buildChecklist` (`kinds.ts:78-111`)
  was **silently wrong for repo #2**. A latent bug fix, not just prep: `?repo=`
  with an unknown id now 400s instead of quietly serving the default.
- **New `server/gatectx.ts`** — six lines mapping `HubDeps` → `GateCtx`. The
  whole reason core needs no changes.
- **New `server/driving.ts`** — [the `isDriving` oracle](#the-isdriving-oracle).
  Also becomes the single stage-marker reader (`routes/active.ts` imports it).
- **New `web/ui/Confirm.tsx`** — modeled on `ui/Button.tsx`'s one-primitive
  style. `detail` is **prose naming the real-world side effect** ("commits to
  git and opens a pull request against `main`"), not "Are you sure?". Every
  mutating button in PRs 1–4 goes through it.
- **`web/api.ts`** — `postAction<T>`, which does not throw on a
  200-with-`ok:false` (see [the 200 rule](#1--gate-actions)).
- **`tsconfig.test.json`** (new, unplanned) — test files were never typechecked;
  see the [Verification](#verification) gotchas.

### The `isDriving` oracle

The subtlest piece in this document. Extract `readStageMarker` /
`StageMarkerSchema` out of `routes/active.ts:23-29,86-98` into `driving.ts` and
have `active.ts` import it — one reader, not two that drift.

```
makeDrivingOracle(deps, now?) → { isDriving: (id) => boolean; markerTaskId; claimedIds; watcherLive; leasePid }
```

Two signals, in order of strength:

1. **Claim markers — the load-bearing one.** A loop claims a task (an atomic
   `mkdir` under `<status>/.claims/`, `store.ts:341`) *before* it starts driving
   it and holds the claim throughout, so **driving implies claimed**. That makes
   claims a **per-task** signal. Scan every pool any enabled kind declares
   (`board.pools`, as `routes/backlog.ts:51` already does) — PLAN claims live in
   `queued/`, not just `in-progress/`.
2. **The stage marker** (`runs/.stage.json`) — written by the Claude host while a
   stage runs, and it names the task. The OpenCode host writes none.

`isDriving(id)` is `claimed.has(id) || id === markerTaskId`.

The bias is deliberate: a stranded claim causes a spurious refusal, a
recoverable annoyance the doctor clears. A false *not*-driving re-queues a task
mid-BUILD and destroys work. **When unsure, say driving.**

**The watch lease is deliberately not a driving signal.** It is tempting — the
OpenCode host writes no stage marker, so a live watcher looks like an opaque
blind spot. It isn't: a watcher claims before it drives, so a live watcher
holding *no* claim is polling, not driving. Blocking on the lease would refuse
every gate move for as long as a watcher runs, which is the normal workflow
(the watcher polls while you approve). It is reported as `watcherLive` /
`leasePid` for context and honest refusal messages only.

The residual race — the watcher lists claimable work, you replan, the watcher
then claims — is the same window `claimTask`'s atomic `mkdir` leaves for any two
claimers, and both hosts already live with it. `expectStatus`
([1](#1--gate-actions)) narrows it further.

---

## Security posture

**The posture is already right; the job is not to weaken it.** Every new
mutating route inherits, unchanged:

- 127.0.0.1 bind (`main.ts:167`)
- `isLocalHost` Host-header / DNS-rebinding guard (`http.ts:196`)
- `X-Hub-Client: 1` required on `mutating: true` (`http.ts:221`) — the CSRF
  guard. No CORS headers are ever served, so a cross-origin page can neither
  read responses nor send that header without a failing preflight.
- 1 MB body cap (`http.ts:129`), `isSafeId` on every id reaching the filesystem
  (`http.ts:85`), path containment (`kinds.ts:131-133`)

**Add no new mechanism.** The only real risk is forgetting `mutating: true` or
`isSafeId` on a new route — make it a review checklist item per route.

Ranked risks, each with its rail:

| # | Risk | Mitigation |
|---|---|---|
| 1 | Config write flattens the user layer → **commits `ado.pat`** | Layer-explicit routes; `effective` never written; sentinel round-trip; gitignore guard ([Crux B](#crux-b--the-layer-footgun)) |
| 2 | Config write **strips `watchIntervalMinutes` / `hub`** | Raw-is-the-model; headline regression test; visible passthrough ([Crux A](#crux-a--the-strip-footgun)) |
| 3 | **replan re-queues a task mid-BUILD** → destroys work | `isDriving` reads claims (driving implies claimed) + the stage marker, biased to "driving" ([oracle](#the-isdriving-oracle)) |
| 4 | A click **opens a real PR** | Danger `<Confirm>` naming the effect in plain words |
| 5 | Stale-board gate action | `expectStatus` → 409 |
| 6 | Doctor **releases a live claim** | Core's own orphan predicates (`isOrphanedClaim` / `isOrphanedPlanClaim`), not `isDriving` — every candidate is claimed by definition |
| 7 | Bad hand-edited config kills the server | Keep-old-deps-on-throw |

Risks 1 and 2 are why the config editor is **Cost: L** and ships last.

### On secret redaction

Worth stating plainly, because it's easy to get backwards: **redaction is
already handled, and the hub inherits it for free.**

[Improvement 05](./improvements/05-secret-redaction.md) shipped `redact` as a
**write-boundary** control — core scrubs secrets *before* durable artifacts land
on disk, wired at `store.ts:579` (`appendNote`), `:610`, and `:617`
(`appendPlan`). So the agent-written parts of a task file the hub serves at
`backlog.ts:90` were already redacted when they were written.

Applying `redact()` again on the hub's **read** path would therefore be
redundant for exactly the content that needs it, while its generic-assignment
rule (`redact.ts:53`) would eat legitimate prose in any task that *discusses*
auth — which engineering tasks routinely do. Don't.

Config's `ado.pat` is a different problem and gets a different tool: it's a
**known-path** secret, so the sentinel handles it precisely ([Crux
B](#crux-b--the-layer-footgun)). A regex is the wrong instrument there.

---

## Verification

**How the hub is tested today:** `node --test` via `tsx`, no framework
(`packages/hub/package.json`). The pattern (`routes/kinds.test.ts:13-23`):
construct a literal `HubDeps`, call the handler with `{ params, query, body }`,
assert on the `JsonResponse`. Real-fs fixtures via `os.tmpdir()`
(`routes/save.test.ts`). The shipped manifests double as fixtures.

**Two gotchas:**

- `HubDeps` gains `config` in PR 0 → **every existing test fixture must add
  it**. Mechanical, ~6 files; do it in PR 0, not later. Worse, nothing *tells*
  you: `tsconfig.json` doubles as the build config, so it excludes `*.test.ts`
  to keep tests out of `dist/` — and the runner is `tsx`, which strips types
  without checking them. A fixture that stopped satisfying `HubDeps` failed
  neither the build nor the suite. PR 0 adds `tsconfig.test.json` to close this;
  `packages/core` has the same gap, unfixed.
- The test glob does not cover `src/web/*.test.ts` outside `creator/`. Keep new
  web tests there, or widen the glob explicitly.

Per feature:

- **Gate** (`routes/gate.test.ts`) — tmpdir + `git init`. Each action moves the
  file and commits; `expectStatus` mismatch → 409; traversal id → 400; **replan
  refused when the marker names the id**; **replan refused when the task holds a
  claim**; **replan allowed when a watcher lease is live but the task is
  unclaimed** (the watcher is polling, not driving); `ok:false` returns 200
  preserving `variant`. Ship uses a stub `sh` that fails `gh` — assert the task
  still completes and the note records "PR not opened" (`gate.ts:265-268`).
  **No network in tests.** (driving.ts's own matrix is covered by
  `driving.test.ts`, landed in PR 0.)
- **Doctor** — the report is read-only (assert the fs is byte-identical after a
  GET); fix rescues a stray and commits; duplicates reported but untouched; a
  **fresh** claim is not released while an **orphaned** one is; a stray colliding
  with an existing draft lands in `failed` without throwing.
- **Preview** — engineering's real shipped prompts render; toggles change the
  output; a check stage gets the verdict block; a compose-hooked stage returns
  the note and does not throw; unknown stage → 400.
- **Config** — the heaviest suite, rightly:
  - **strip regression (the headline test)** — a repo file containing
    `watchIntervalMinutes` **and** a `hub` section; patch `maxIterations`; assert
    both survive byte-for-byte.
  - **layer isolation** — user layer has `ado.pat`; patch `maxIterations` on the
    repo layer; assert the repo file gains **no** `ado` key.
  - **provenance oracle** — property test vs `mergeConfigLayers`; arrays and
    `null` replace wholesale.
  - **secret round-trip** — GET redacts to the sentinel; POST echoing the
    sentinel preserves the real value; POST with a new value replaces it.
  - **gitignore guard** — setting `ado.pat` where the file isn't ignored → 400.
  - **validation** — `codePlatform: "ado"` with no `ado` section → 400 carrying
    the `superRefine` issue at path `["ado"]`; `ado` without `selfLogin` → 400 at
    `["ado","selfLogin"]` (`config.ts:150-169`).
  - **knob lint** — typo → suggestion; wrong type → warning; wrong source →
    warning; **all still write** (advisory).
  - **drift alarm** — registry keys === knob names regexed out of
    `orchestrate.ts`.
  - **parse error** — malformed JSON → 200 with `parseError`, not a 500.
  - **reload** — a failed reload leaves the old deps intact.

**End-to-end.** `npm run test:all` and `npm run typecheck:all` (typecheck runs
both the server and web tsconfigs, so new wire types must satisfy both). Then
drive the real app: start the hub, click a gate button on a task in
`plan-review/` and confirm the file moved **and a commit landed**; start an
OpenCode watcher and confirm replan refuses; edit `maxIterations` in the Config
tab and confirm the board reflects it **without a restart**; hand-edit the file
in `$EDITOR` and confirm the watcher reloads.

---

## Docs to update

Per the [improvements convention](./improvements/README.md#conventions-every-plan-follows),
docs are part of done:

- **[`architecture.md`](../architecture.md)** — the load-bearing edit. "**observes**
  … and never drives the loop" becomes false the moment PR 1 lands. Rewrite to
  the precise boundary: the hub observes *and* performs the human gate moves,
  backlog repairs, and config edits, through the **same shared core entry
  points** both hosts use — it does not drive *stages*. **A fourth caller of the
  gate, not a fourth driver.**
- **[`packages/hub/README.md`](../../packages/hub/README.md)** — delete "The
  monitor is deliberately **read-only** — gate actions … a candidate for a later
  release" (:110-111). Replace with the write surface, the posture, and the two
  honest limitations: **a gate move on a claimed task is refused until the loop
  releases it (or the doctor does)**, and **ship opens a real PR**. Add
  manual-QA items: confirm dialogs, config save → reload without restart, gate
  buttons against a live watcher.
- **[`configuration.md`](../configuration.md)** — document the editor:
  layer-explicit editing, provenance, the passthrough rule, `ado.pat`
  redaction, the gitignore guard, advisory knob linting. **Cross-link the
  `loops.<kind>` knob table** ([Crux C](#crux-c--loops-is-looseobject)) and fix
  the "validated by the kind itself" claim at :126 — a doc fix that pays for
  itself independent of this feature.
- **[`threat-model.md`](./threat-model.md)** — the new mutating surface: which
  routes write, what they commit, why localhost + Host guard + `X-Hub-Client` is
  the boundary, and that a PR-opening click now exists.
