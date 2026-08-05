# Workflow kinds

A **workflow kind** is a declarative definition of one agentic loop: its stages,
transitions, prompts, guardrails, and where its work comes from. The shared
engine (`@agentic-workflow/core`) interprets these definitions; both the OpenCode
plugin and the Claude Code MCP server drive them through the same scheduler.

```
workflows/
├── engineering/          # PLAN → BUILD → VERIFY → REVIEW over docs/tasks/
│   ├── workflow.json
│   └── stages/{plan,build,verify,review}.md
├── pr-sitter/            # TRIAGE → FIX → VERIFY → PUBLISH over open PRs
│   ├── workflow.json
│   └── stages/{triage,fix,verify,publish}.md
├── review-sitter/        # FETCH → ASSESS → PUBLISH over requested reviews (comment-only)
│   ├── workflow.json
│   └── stages/{fetch,assess,publish}.md
├── dep-sitter/           # SCAN → UPGRADE → VERIFY → PUBLISH over npm advisories
│   ├── workflow.json
│   └── stages/{scan,upgrade,verify,publish}.md
└── main-sitter/          # DIAGNOSE → REMEDY → VERIFY → PUBLISH over red default-branch CI
    ├── workflow.json
    └── stages/{diagnose,remedy,verify,publish}.md
```

Each kind's usage quickstart (enable snippet, commands, worked examples) lives at
[`docs/workflows/<kind>.md`](../../../docs/workflows/). This page stays the manifest/authoring reference.

Ideas for further kinds are cataloged in
[`docs/design/proposed-workflows.md`](../../../docs/design/proposed-workflows.md).

## workflow.json anatomy

Validated by `packages/core/src/manifest/schema.ts` (zod — a broken manifest
fails loud at host startup). A minimal two-stage kind:

```jsonc
{
  "kind": "example",
  "version": 1,
  "description": "What this loop sits on and does.",
  "workSource": {                       // where claimable work comes from
    "type": "backlog",                  // or "pull-request" | "dependency-scan" | "ci-runs"
    "statuses": ["queued", "done"],     // the folder set (backlog only)
    "pools": [                          // claim pools, priority order
      { "status": "queued", "entryStage": "work" }
    ]
  },
  "maxIterations": 3,                   // shared retry budget for counted fires
  "stages": [
    {
      "name": "work",
      "kind": "work",                   // "work" completes on its own …
      "command": "build",               // OpenCode slash command it fires
      "agent": "workflow-build",            // subagent persona backing it
      "prompt": "stages/work.md",       // template, relative to this folder
      "isolation": "worktree",          // "worktree" | "none" (main tree, no snapshot)
      "timeoutMinutes": 90,             // optional wall-clock cap override; defaults to config.stageTimeoutMinutes
      "model": "anthropic/claude-sonnet-4-5",  // optional host-specific model; config workflows.<kind>.stageModels.<name> wins, unset = host default
      "planContract": true              // optional; work stages only — append the plan-structure contract, and refuse to park a plan with no ### Verification subsection
    },
    {
      "name": "check",
      "kind": "check",                  // … "check" must record a workflow_verdict (missing = FAIL)
      "command": "verify",
      "agent": "workflow-verify",
      "prompt": "stages/check.md",
      "isolation": "worktree",
      "requiredAxes": ["correctness", "security"],  // optional; check stages only — workflow_verdict rejects a verdict missing any of them
      "fanout": "axis",                 // optional; check stages with requiredAxes — run one focused pass per axis, merged worst-wins
      "requireEvidence": true,          // optional; check stages only — a PASS must cite the commands/files it observed, cross-checked against what the host saw
      "checks": [{ "name": "tests", "command": "npm test" }],  // optional; check stages only — the DRIVER runs these before firing the stage, and their exit codes bind its verdict
      "context": { "work": 8000 },      // optional per-artifact character ceilings for THIS stage's prompt; config workflows.<kind>.stageContext.<name> replaces it, unset = unbounded
      "bashAllowlist": ["git diff*", "npm test*"]  // default-deny bash for this stage
    }
  ],
  "transitions": {
    "work":  { "onDone": { "kind": "fire", "stage": "check" } },
    "check": {
      "onPass":  { "kind": "done", "message": "✓ done" },
      "onFail":  { "kind": "fire", "stage": "work", "countIteration": true,
                   "dropArtifacts": [], "capMessage": "✗ stopped after {maxIterations} iterations." },
      "onError": { "kind": "stop", "message": "✗ environment error." }
    }
  },
  "hooks": { "compose": {}, "validateBeforeTransition": {} }
}
```

Transition **effects**:

- `fire` — run another stage. `countIteration: true` spends one unit of the
  shared `maxIterations` budget and requires a `capMessage`
  (`{maxIterations}` interpolates); `dropArtifacts` removes stale feedback
  that judged an older attempt.
- `park` — exit the loop at a human gate; `toStatus` names the work-source
  status the item parks into (engineering's PLAN → `plan-review`).
- `done` — terminal success, with a message and an optional `toStatus` (the
  work-source status the item lands in, e.g. `in-review`).
- `stop` — terminal halt, with a message only (no `toStatus`).

Every stage needs a transitions entry; `work` stages need `onDone`, `check`
stages need all of `onPass`/`onFail`/`onError`. A missing verdict on a check
stage resolves as FAIL — never as a stall, never parsed from prose.

A check stage may also declare `requiredAxes`. The stage prompt then carries the
per-axis payload contract, and `workflow_verdict` **rejects** a verdict whose `axes`
array misses any of them, so a multi-axis review cannot silently skip one. The
recorded verdict is also worsened to match its axes — a declared PASS carrying a
Critical or Important finding resolves as FAIL. `requiredAxes` on a `work` stage
is a manifest error (there is no verdict to carry them), and `reviewLenses` mode
suppresses the **per-pass** enforcement (see `docs/configuration.md`).

Such a stage may also declare `fanout: "axis"`: it then runs **one focused pass
per required axis**, each pass told to review and report exactly that axis, and
the passes merge worst-wins. On the OpenCode plugin they run **concurrently** by
default — the fan-out is the request for N focused passes — and
`workflows.<kind>.stageConcurrency` clamps that (see `docs/configuration.md`);
the Claude Code and Qwen Code hosts run them one at a time. Per-pass admission narrows to the
pass's own axis — otherwise every focused pass would be rejected for the axes it
was told not to review — and the stage-wide requirement moves to the accumulated
record, so a fan-out that never reported an axis stops the loop with ERROR rather
than re-building on an incomplete review.

`reviewLenses` is the free-text sibling: its passes are lenses, not axes, so
per-pass enforcement is off there too, and each pass is asked for per-axis results
only for the axes its lens actually bears on — an axis it did not examine must be
left out rather than guessed at, since the passes merge worst-wins and a guessed
clean PASS would become the stage's verdict for an axis nobody reviewed. The
accumulated check still applies whenever the configured lenses between them name
every required axis; when they don't, those axes go unreviewed and both hosts warn
which ones.

A check stage may also declare `requireEvidence: true` (engineering's `verify`
and `review` do). A **PASS** on such a stage must then carry an `evidence` array
citing what it observed — `{ kind: "command" | "file", ref, result? }` — and the
host cross-checks those citations against the commands and file reads it recorded
independently while the stage ran. A PASS citing nothing, a PASS from a pass that
ran nothing, and a PASS whose every citation matches nothing observed are all
**rejected**, not recorded. FAIL and ERROR are never gated: a check that could not
run is an ERROR whose reason names what is missing, and demanding evidence there
would trap the stage in a rejection loop.

The cross-check is deliberately loose — **at least one** citation must be
corroborated, not all of them. A false rejection burns the stage's retry and
ERROR-stops the loop, which costs more than an over-generous match; the mode this
closes is the PASS that observed *nothing*. Like `requiredAxes`, it is a
completeness check rather than an honesty check: it makes the claim explicit and
falsifiable, not true. A host that does not record tool calls falls back to the
declared-evidence rule alone — the gate weakens, it never silently vanishes.
`requireEvidence` on a `work` stage is a manifest error (there is no verdict to
carry it).

A **work** stage may declare `planContract: true` (engineering's `plan` does).
Its composed prompt then carries the plan-structure contract after the scope
fence — numbered steps naming file paths, a `### Verification` subsection
mapping each acceptance criterion to its proof, and an explicit
`### Out of Scope` — and the park validator refuses to park a plan with no
Verification subsection (the task stays queued, the claim is released). Only
that one heading is enforced deterministically, with a tolerant match
(case-insensitive, `### Verification & Testing` passes): the other clauses are
prose-quality demands held by the contract text and the human plan gate, where
a regex would be all false-refusal. `planContract` on a `check` stage is a
manifest error (it writes no plan).

A check stage may also declare `checks` — `{ name, command, cwd? }` entries the
**driver** runs in the stage's work tree, sequentially, before the stage fires
(none of the shipped kinds declares any today). Their results are rendered into
the stage's prompt, seeded as observed evidence, and folded into its verdict as a
synthetic `checks` axis: exit 0 adds nothing, 126/127 resolves the stage to
**ERROR** (the check could not run — stop for a human, spend no iteration), and
any other exit code resolves it to **FAIL**. The stage cannot argue a red check
down; the escape hatch is removing the check, not disputing it.

Because the driver runs them, they bypass `bashAllowlist` entirely — the agent
never issues them. That makes this a **trusted authoring surface**, at the same
level as `bashAllowlist` itself: manifests resolve from the core package's
install location, not from a watched repo, so a clone cannot inject one.
"Trusted" means *authored*, not unreachable — the hub writes into that directory
and `AGENTIC_WORKFLOW_WORKFLOWS_DIR` can repoint it. The config half of the same
feature, `workflows.<kind>.stageChecks`, replaces this list wholesale and IS shell
a repo could ship, so it is honored from the user-scope config only. Duplicate
`name`s in one stage, or `checks` on a `work` stage, are manifest errors.

`fanout` is a manifest error on a `work` stage, on a stage with no
`requiredAxes` (the axis list is the pass list), and over more than
`FANOUT_MAX` (8) axes — each axis is a full subagent pass with its own stage
timeout, so the list is a direct cost multiplier. Config
`workflows.<kind>.stageFanout.<name>` overrides it (`"none"` turns it off), and
that config key is how the built-in kinds are reached at all, since their
manifests ship inside the core package.

Any stage may declare `context`: per-artifact **character** ceilings on the prompt
this stage composes, keyed by the producing stage's name. Unset ⇒ unbounded, which
is byte-identical to having no budgets. The budget belongs to the **consuming**
stage because the same artifact is read by several stages with different needs — so
`{"context": {"work": 8000}}` on the `check` stage caps what `check` reads of
`work`'s output, not what `work` produces. A key naming no stage of the manifest is
a manifest error (unlike the config layer, the stages are known here). Over-budget
text is elided from the middle, keeping head and tail; the structured verdict block
and the stage contract are never trimmed, and the run log keeps the full text
regardless. Config `workflows.<kind>.stageContext.<name>` replaces this map
wholesale — see `docs/configuration.md`.

## Stage prompt templates

`stages/*.md` files compose the prompt threaded into each stage command
(`packages/core/src/manifest/template.ts`):

- A file is a sequence of **sections** separated by lines containing only
  `---`. Each section renders independently; sections that render empty are
  dropped; survivors join with a blank line.
- `{{path}}` interpolates a context value (dot paths: `git.branch`).
- `{{#path}}…{{/path}}` renders its span only when the value is truthy
  (non-empty string). Blocks nest.

Context available: `goal`, `iteration`, `iterations.human`/`iterations.cap`/
`iterations.final` (the iteration budget, human-numbered against the resolved
`maxIterations`; defined only after a counted re-fire and when a cap is
resolvable, so a first fire and a config-less compose stay unchanged —
`iterations.final` is truthy exactly on the iteration whose check failure
trips the cap), `task.id`/`task.path`,
`acceptance.bullets` (pre-rendered `- …` list), `artifacts.<stage>` (each
completed stage's captured output; the approved plan under `artifacts.plan`),
`verdicts.<stage>` (the structured verdict head a check stage recorded through
`workflow_verdict` — the seam alone, clamped to the exempt ceiling, without
the transcript; undefined until a check stage records one, so a template can
show what a stage *established* without inlining its whole output),
`git.base`/`git.branch`/`git.worktree`/`git.diffCmd` (precomputed review diff
command), `worktree.instructions` (the standard pinning paragraph — every
kind gets isolation discipline for free by including it), and
`platform.github`/`platform.ado` (exactly one is truthy, per the resolved
code platform — pr-sitter stages branch on these to pick `gh` vs ADO
guidance; the ADO sections render curl REST command examples, the only way
the loop reaches Azure DevOps).

## Work sources

- **`backlog`** — markdown task files in status folders under the configured
  `tasksDir` (engineering). Pools are walked in priority order; claims are
  atomic `.claims/` mkdir markers; `claimPredicate` names a registered
  predicate (e.g. `engineering.isClaimable`).
- **`pull-request`** — open hosted PRs needing attention per the `triggers` list.
  Works on **GitHub or Azure DevOps**; the binding names the kind of work item,
  not the forge, and `codePlatform` picks which client backs it. (This type was
  spelled `github-pr` before it grew ADO support; manifests using the old name
  still load — it is normalized on read.) Triggers are
  (`failing-checks`, `changes-requested`, `new-comments`, `merge-conflict`,
  `review-requested`), deduped by the per-PR ledger under
  `<tasksDir>/runs/<kind>/` (namespaced per kind, so pr-sitter and
  review-sitter never share bookkeeping). Drafts and fork PRs are skipped;
  the PR's head is fetched into a local branch at claim so isolation reuses
  it. The optional `role` (`author`, the default, or `reviewer`) states the
  kind's relationship to the PRs it claims — on ADO, where there is no
  server-side search query, it picks the client-side identity filter
  (`createdBy` vs pending-reviewer membership). The concrete platform is
  resolved from config `codePlatform` at wiring time: `github` polls
  `gh pr list --search <query>`; `ado` polls the Azure DevOps MCP server
  (`repo_list_pull_requests_by_repo_or_project`) with failing checks read from
  the PR's validation **pipeline runs** (`pipelines_get_builds`) — a repo whose
  PRs run no pipeline never fires `failing-checks`, and branch policies that
  are not pipelines are not visible at all, because the server exposes no
  policy tool.

  Stage `platformAllowlist` entries merge into `bashAllowlist` for the resolved
  platform, but the `ado` list is **empty**: Azure DevOps is reached only
  through MCP tools, so no bash glob would be anything but a second, unguarded
  door to the same API. The ADO surface is `platformTools.ado` instead — the
  tool names that stage may call, which also generate its agent `tools:`
  frontmatter on every host. What a call may *do* is enforced by the write
  backstop (`isAdoMcpWriteViolation`: reads, thread posts, and creating a PR
  with `isDraft: true`; everything else, including any unrecognized tool, is
  refused) plus the per-stage budget (`isAdoMcpToolOutOfStageScope`).
- **`dependency-scan`** — direct dependencies with a fixable advisory at or
  above `severityFloor`, optionally plus plainly outdated ones
  (`includeOutdated`, npm only). Three ecosystems behind one policy, chosen
  by the `ecosystem` binding (`auto` detects `package.json` / `pom.xml` /
  `build.gradle(.kts)` and merges candidates severity-first): **npm** via the
  native `npm audit`/`npm outdated`, **maven/gradle** via OSV-Scanner
  (`osv-scanner --format json -L <pom.xml|gradle.lockfile>`, normalized by
  `src/source/osv.ts` into the same candidate shape — Gradle needs dependency
  locking, and vulnerable packages not declared in the build files are logged
  as transitives, never claimed). One item per dependency, deduped by a
  per-dependency ledger under `<tasksDir>/runs/<kind>/dep-<pkg>.json`; a
  bump outside the `autoFix` classes (majors always) is logged and never
  claimed. Platform-agnostic — dependency reports don't care which forge the
  repo lives on; the entry state is stamped with the resolved platform
  (`platformFor(config, kind)`) and only the publish stage's PR-creation call
  differs.
- **`ci-runs`** — the watched branch's newest head when its completed CI runs
  conclude red (`gh run list` on GitHub, the Azure DevOps MCP server's
  `pipelines_get_builds` tool on `ado`; `branch` defaults to the remote default
  branch, `workflows` narrows the judgement). Heads with runs still in
  flight are left alone; a green re-run or a newer push retires the item
  naturally. Deduped per head under `<tasksDir>/runs/<kind>/head-<sha>.json`;
  at claim the red head is pinned to a local `<kind>/<sha>` branch for
  isolation. The GitHub source (`ci-runs.ts`) and its ADO sibling
  (`ado-ci-runs.ts`) share the ledger, claim-marker, and WorkItem mechanics
  via `ci-runs-shared.ts` — normalizing raw ADO builds into the same `CiRun`
  shape (`ado-shared.ts`'s `normalizeAdoBuild`) is what lets the pure
  `newestHeadVerdict` judge both platforms identically.

## The TS escape hatch

Logic a manifest can't express hangs off named refs. Three kinds are resolved
through `packages/core/src/manifest/registry.ts`:

- `hooks.compose.<stage>` — augment the template context before rendering.
- `pools[].claimPredicate` — claimability predicates for backlog pools.
- `hooks.validateBeforeTransition.<stage>` — a check that vetoes a park/done
  whose side conditions don't hold, resolved via `resolveValidateHook`.

These are registered before the first poll (see
`packages/core/src/kinds/engineering.ts`; hosts call `registerEngineeringHooks()`
at startup — engineering registers only `engineering.isClaimable`).

Engineering names `validateBeforeTransition.plan =
"engineering.planLandedOnDisk"` ("the PLAN actually landed on disk") but
deliberately leaves that ref **unregistered** — the check needs backlog IO, so
the ref resolves to `null` and each host runs the check directly in its park
handler instead (`plugins/claude/mcp-server/src/server.ts`, `src/workflow/driver.ts`
— they re-read the task file and confirm the `## Implementation Plan` heading
landed). The registry path is there for kinds whose validation is pure.

## Enabling a kind

`.agentic-workflow.json` at the target repo's root:

```json
{
  "workflows": {
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

`engineering` runs unless explicitly disabled (`"engineering": { "enabled":
false }`); every other kind — all four sitters, plus any you author here — is
experimental and opt-in with `"enabled": true`. Kind-specific knobs (like the
sitter's `query`) live in the same section but never enable a kind on their
own. The scheduler polls enabled kinds in claim-priority order — engineering's
backlog first, then the opted-in kinds in config order.

## Checklist for a new kind

1. `workflows/<kind>/workflow.json` + `stages/*.md` (this page + the zod schema are
   the contract; `npm test -w @agentic-workflow/core` exercises manifest
   validation).
2. Stage **agents** for all three plugins: author the source under
   `prompts/agents/workflow-<kind>-*/` (`body.md` + `opencode.yaml` — frontmatter
   bash permissions mirror the manifest allowlists — + `claude.yaml` + `qwen.yaml`)
   and run `npm run gen:prompts`; it renders into `plugins/opencode/agents/`,
   `plugins/claude/agents/`, and `plugins/qwen/agents/` (never edit those outputs
   — CI drift-checks them; the PreToolUse guard enforces the manifest allowlist
   via the stage marker). See [`prompts/README.md`](../../../prompts/README.md)
   for how the generation pipeline works.
3. OpenCode **commands** for each stage `command` that doesn't already exist
   (`plugins/opencode/commands/<command>.md`, thin `agent:`-frontmatter
   wrappers).
4. A **work source** if neither `backlog` nor `pull-request` fits
   (`packages/core/src/source/`, implement `WorkSource`), wired into every
   host's `sourcesFor`.
5. Registry hooks, registered at host startup.
6. **Tests**: an engine walk of the manifest (see the pr-sitter cases in
   `core/src/workflow/engine.test.ts`) and source tests with scripted shells
   (see `source/github-pr.test.ts`).
7. Config docs: `docs/configuration.md` + the threat model if the kind gains
   new authority (push, comment, network).
